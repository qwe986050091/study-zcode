// UI 消费的服务门面：把各业务域的服务接口聚合成一个只读对象，由 Host 启动时装配一次；
// UI 只面向本接口编程，不直接引用具体实现类，保证 Desktop / Web / 远端共用同一套调用面。
// 字段分两类：无 ? 的是所有 Host 都必须提供的核心能力，带 ? 的是平台或版本可选能力，
// 调用方必须按可选处理并准备降级，避免旧 server wire 或测试 double 因缺字段而崩溃。
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";
import type { ITaskGroupService } from "#src/task-groups/contract.js";
import type { WindowProjectDirectoryServices } from "#src/window-project-directory/contract.js";
import type { IProjectService } from "#src/project/contract.js";
import type { IGenUiService } from "./gen-ui/contract.js";
import { IOffPeakTaskService } from "./session/offPeakTask.js";
import type { IHighspeedCardService } from "./highspeed/highspeedCard.js";
import type { IPluginUiBridgeService } from "./plugin-ui-bridge/contract.js";
import type { IPluginUiSamplingService } from "./plugin-ui-bridge/samplingContract.js";
import type { IPluginUiAppToolsService } from "./plugin-ui-bridge/appToolsContract.js";
import type { IFileService } from "./file/file.js";
import type { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { ICloudContentService } from "#src/cloud-content/cloudContent.js";
import type { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";
import type { IGitService } from "./git/git.js";
import type { IGitCheckpointService } from "./git/gitCheckpoint.js";
import type { ISystemService } from "./system/system.js";
import type { ITerminalService } from "./terminal/terminal.js";
import type { ISettingService } from "./setting/setting.js";
import type { ICredentialService } from "./credential/credential.js";
import type { IBroadcastService } from "./broadcast/broadcast.js";
import type { IZCodeTaskService } from "./session/zcodeTaskService.js";
import type { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import type { ICuaPermissionService } from "./cua-permission-broker/cuaPermissionService.js";
import type { IBotsService } from "./bots/bots.js";
import type { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import type { IOAuthService } from "./oauth/oauth.js";
import type {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import type { IUsageStatsService } from "./usage-stats/usageStats.js";
import type { ICodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscription.js";
import type { IClientConfigService } from "./client-config/clientConfig.js";
import type { IClientScenesService } from "./client-scenes/clientScenes.js";
import type { ISkillsService } from "./skills/skills.js";
import type { ISkillSyncService } from "./skill-sync/skillSync.js";
import type { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import type { IPluginSyncService } from "./plugin-sync/pluginSync.js";
import type { IPluginsService } from "./plugins/plugins.js";
import type { IPluginManagementService } from "./plugins/pluginManagement.js";
import type { ISubagentsService } from "./subagents/subagents.js";
import type { ICommandsService } from "./commands/commands.js";
import type { IHooksService } from "./hooks/hooks.js";
import type { IMemoryService } from "./memory/memory.js";
import type { IOutputStyleService } from "./output-style/outputStyle.js";
import type { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import type { IFeedbackService } from "./feedback/feedback.js";
import type { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import type { IWindowControllerService } from "./window-controller/windowController.js";
import type { ISourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspace.js";
import type { ISourceServerManagementService } from "./source-server-management/sourceServerManagement.js";
import type { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
import type { IConversationShareService } from "./conversation-share/conversationShare.js";

/** UI 层消费的统一服务接口 */
// 新增字段时同步更新 Host 装配与 RPC wire：这里只是类型契约，
// 不包含运行时默认值，缺省语义一律由调用方显式判断。
export interface IServiceAccessor {
// 任务分组与项目目录属于可选能力：老 Host 只提供扁平任务列表，
// UI 拿不到时必须回退到无分组视图，而不是自行构造默认实现。
  readonly taskGroupService?: ITaskGroupService;
  readonly projectService?: IProjectService;
  readonly remoteProjectService?: IRemoteProjectService;
  readonly windowProjectDirectory?: WindowProjectDirectoryServices;
// 文件系统是基础能力，所有 Host 都必须提供，其余服务可依赖它完成读写。
  readonly fileService: IFileService;
  readonly mediaPreviewService?: IMediaPreviewService;
  readonly cloudContentService?: ICloudContentService;
  readonly marketingTouchService?: IMarketingTouchService;
  readonly gitService: IGitService;
// checkpoint 服务与 git 服务分开暴露：前者服务会话回滚，后者服务用户手动 Git 操作。
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  /** Onboarding 完成记录（本地持久化）；旧测试 double / 不支持的 host 可不提供。 */
  readonly onboardingRecordService?: IOnboardingRecordService;
// 凭据服务只暴露登录状态与句柄，UI 不应接触明文密钥。
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
// task 面负责持久化任务事实，session 面负责运行实例，两者不可混用。
  readonly zcodeTaskService: IZCodeTaskService;
  /** 窗口 Host 聚合面；旧 server wire 或测试 double 可暂不提供。 */
  readonly windowControllerService?: IWindowControllerService;
  readonly zcodeAgentService: IZCodeAgentService;
// 会话服务是运行时入口：创建、恢复、中断都走这里；
// 与 task 服务保持单向边界，避免 UI 用 session 状态反推任务状态。
  readonly zcodeSessionService: IZCodeSessionService;
  // CUA 是 opt-in 内测特性：local macOS host 提供，远端 等 host 没有。可选避免连锁必填。
  readonly cuaPermissionService?: ICuaPermissionService;
  readonly conversationShareService: IConversationShareService;
  readonly botsService: IBotsService;
  readonly fileWatcherService: IFileWatcherService;
// OAuth 仅在需要第三方授权的 Host 上可用，未登录时返回可恢复错误。
  readonly oauthService: IOAuthService;
  /** 当前 Environment 的 Provider 配置与设置视图。 */
  readonly providerSettingsService: IProviderSettingsService;
  /** 当前 Environment Registry 发布的唯一模型选择 View。 */
  readonly modelSelectionService: IModelSelectionService;
  /** Source Server 端 workspace 身份解析；本地 Host 也注册一份以保持合同一致。 */
  readonly sourceServerWorkspaceService: ISourceServerWorkspaceService;
  /** 仅桌面窗口 Host 的 base attachment 注册；远端 / Web 不提供。 */
  readonly sourceServerManagementService?: ISourceServerManagementService;
// 用量统计只用于展示，不参与计费决策，避免 UI 缓存影响权威数据。
  readonly usageStatsService: IUsageStatsService;
  readonly codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  readonly clientConfigService: IClientConfigService;
  readonly clientScenesService: IClientScenesService;
  /** 闲时任务管理（独立服务面）。 */
  readonly offPeakTaskService: IOffPeakTaskService;
  readonly highspeedCardService: IHighspeedCardService;
// Skills 的读取/启停与远端同步分离，本字段只暴露本地生效的视图。
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly mcpSyncService: IMcpSyncService;
  /** 插件 UI 桥；web 或旧 host 可不提供，UI 据此回退普通 MCP 卡片。 */
  readonly genUiService?: IGenUiService;
  readonly pluginUiBridgeService?: IPluginUiBridgeService;
  /** 页面 sampling；只有桌面本地任务开放。 */
  readonly pluginUiSamplingService?: IPluginUiSamplingService;
  /** App-Provided Tools；只有桌面本地 agent 时存在。 */
  readonly pluginUiAppToolsService?: IPluginUiAppToolsService;
// 插件同步负责把远端清单落到本地，运行时插件实例仍由 pluginsService 管理。
  readonly pluginSyncService: IPluginSyncService;
  readonly pluginsService: IPluginsService;
  /** 设置页插件管理（UI 不再直触 zcodeAgentService 的 plugins/* 面） */
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
// 斜杠命令、Hooks、记忆与输出风格共用本地配置，分别暴露以便独立刷新。
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly outputStyleService: IOutputStyleService;
// 设置同步只处理跨设备合并，单机读写仍走 settingService。
  readonly settingsSyncService: ISettingsSyncService;
  readonly feedbackService: IFeedbackService;
// 附件传输是长任务：UI 上传/下载后拿到稳定 id，再交给消息发送链路；
// 失败重试由调用方驱动，本接口不内置自动重试，以免产生重复上传。
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;
}
