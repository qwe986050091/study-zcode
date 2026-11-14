// 远程 workspace RPC 合约（channel 清单 + 版本号 + 断言）。
//
// 职责：声明远端 Host 必须提供的 ServiceAccessor channel 集合，并提供一次性完整性断言；
// 用于建连后尽早暴露「远端版本过旧 / 缺 channel」，而不是等具体调用才失败。
// 输入输出：输入 Partial<IServiceAccessor>，断言通过后类型收窄为 RemoteWorkspaceRpcContract。
// 副作用：无（只读校验）。
// 失败语义：缺任一 channel 抛错，错误信息列出缺失项与合约版本（便于用户升级远端）。
// 维护的不变量：清单顺序即合约顺序；新增 channel 必须同步提升版本并审阅远端兼容性；
// 校验只判「可调用/非空」，不校验具体方法签名（签名由 RPC 层负责）。

import type { IServiceAccessor } from "@zcode/services";

// 合约版本：与 channel 清单的语义一起演进；远端用它判断是否需要升级。
export const REMOTE_WORKSPACE_RPC_CONTRACT_VERSION = 1 as const;

// 必须提供的 channel 名清单（与 IServiceAccessor 的 key 对齐）。
// 顺序稳定，便于合约 diff 审阅；新增项属于兼容性变更，需同时考虑远端升级策略。
export const REMOTE_WORKSPACE_RPC_CHANNELS = [
  "fileService",
  "genUiService",
  "gitService",
  "gitCheckpointService",
  "systemService",
  "terminalService",
  "settingService",
  "onboardingRecordService",
  "credentialService",
  "broadcastService",
  "zcodeTaskService",
  "zcodeAgentService",
  "zcodeSessionService",
  "conversationShareService",
  "botsService",
  "fileWatcherService",
  "oauthService",
  "providerSettingsService",
  "modelSelectionService",
  "mediaPreviewService",
  "sourceServerWorkspaceService",
  "usageStatsService",
  "codingPlanSubscriptionService",
  "clientScenesService",
  "skillsService",
  "skillSyncService",
  "mcpSyncService",
  "pluginSyncService",
  "pluginsService",
  "pluginManagementService",
  "subagentsService",
  "commandsService",
  "hooksService",
  "memoryService",
  "outputStyleService",
  "settingsSyncService",
  "promptAttachmentTransferService",
] as const satisfies readonly (keyof IServiceAccessor)[];

/**
 * 合同内的 channel 一律按“远端必须提供”收口：IServiceAccessor 上可选的 mediaPreviewService
 * 经 assertRemoteWorkspaceRpcContract 校验后也是必有的，类型上同步去掉可选性。
 */
export type RemoteWorkspaceRpcContract = {
  readonly [K in (typeof REMOTE_WORKSPACE_RPC_CHANNELS)[number]]: NonNullable<IServiceAccessor[K]>;
};

// 断言合约完整性并收窄类型。
// 判定口径：非 null 且为 object 或 function 才算存在（服务实例可能是对象，也可能是可调用函数）。
// 失败语义：抛错并一次性列出所有缺失 channel，避免逐个调用时才暴露。
// 维护的不变量：断言通过后类型即为 RemoteWorkspaceRpcContract，调用方无需再做非空判断。
export function assertRemoteWorkspaceRpcContract(
  value: Partial<IServiceAccessor>,
): asserts value is Partial<IServiceAccessor> & RemoteWorkspaceRpcContract {
  const missing = REMOTE_WORKSPACE_RPC_CHANNELS.filter((channel) => {
    const service = value[channel];
    return (typeof service !== "object" || service === null) && typeof service !== "function";
  });
  if (missing.length > 0) {
    throw new Error(
      `Remote workspace RPC v${REMOTE_WORKSPACE_RPC_CONTRACT_VERSION} channel 不完整: ${missing.join(", ")}`,
    );
  }
}
