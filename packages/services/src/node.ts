import {
  createRemoteProjectService,
// 远端项目服务与本地项目服务共享同一张组织库表，但写入权限由 controller 标志区分：
// 非 controller 只能经连接请求写入，避免两套目录事实并存。
  IRemoteProjectService,
  projectWorkspaceSettings,
  readRemoteProjectDirectory,
} from "#src/remote-projects/index.js";
export {
  createRemoteProjectConnectionAdmission,
  remoteProjectHostIdForProfile,
  remoteProjectHostIdForTarget,
  prepareRemoteServerConnection,
} from "#src/remote-projects/index.js";
import {
  createProjectService,
  createTaskAutoArchiveScheduler,
// 项目服务是项目/任务目录的权威读写点：注册顺序在 taskGroup / remoteProject 之前，
// 后者在构造期就会通过闭包引用它（闭包是惰性的，但注册顺序保证意图清晰）。
  IProjectService,
  shouldRescanTaskAutoArchive,
} from "#src/project/index.js";
export { createLegacySingleRootProjectService } from "#src/project/index.js";
export { createRemoteProjectService } from "#src/remote-projects/index.js";
import { getZCodeDataRootDir as projectDataRoot } from "#src/paths.js";
import { createTaskGroupService, ITaskGroupService, groupTaskKey } from "#src/task-groups/index.js";
import { IGenUiService } from "./gen-ui/contract.js";
import { createGenUiService } from "./gen-ui/node.js";
import { channelReplyHostRequestSchema, channelReplyResultSchema } from "@zcode/shared";
/* eslint-disable max-lines -- host process 服务注册和启动装配需要集中维护，拆散后会更难追踪依赖注入顺序 */
// Node.js service implementations — NOT safe to import in browser code
// 本文件是 Local Host / 独立 Server 进程内的「服务装配总入口」：把元数据仓库、凭据、provider runtime、
// Agent 进程管理、CUA Helper 生命周期、项目/任务域服务逐层拼成 ServiceCollection，再交给 RPC 与调度器使用。
// 这里只做装配与声明式接线，业务判定一律下沉到各 domain factory，避免 host 出现第二份状态事实。
//
// INV-01：同一 ServiceCollection 内每个服务只有一份实例，且域内写入只能经该实例（守住它的位置：
//   createLocalServices 注册链 + 末尾 sqliteRepos/WeakMap 登记；破坏后同一 sqlite 被多条写入路径打开，
//   task 终态在两条连接上互相看不见，UI 侧边栏 spinner 不停）。
// INV-02：所有 process 级资源（Provider Runtime、Provisioning Source、tasks-index sqlite 句柄、CUA Helper
//   host、HostApi 网络 transport）都在 WeakMap 侧表按 ServiceCollection 登记，disposeServiceResources*
//   统一收口（破坏：Windows 上悬空句柄让临时目录清理撞 EBUSY，或 Helper 以已授权主体常驻）。
// INV-03：Helper 生命周期所有权 = 创建它的那个 Host；desktop-attached-remote / standalone-server 绝不
//   自建 CUA Helper（守住它的位置：shouldCreateDefaultCuaProductHelper 与 cuaPipSessionEnabled；破坏：
//   远端 workspace 在本机拉起高权限 Helper，越过 shared-host attachment 与权限边界）。
// INV-04：凭据只在本进程内解析并注入子进程 env，不通过通用 RPC 回传 Renderer（守住它的位置：
//   getAccountRequestAuthService / getProviderProvisioningSource / getOffPeakRequestAuthBuilder；
//   破坏：任意频道都能读到登录态与 provisioning 凭据）。
// INV-05：装配自上而下单向，允许闭包惰性引用尚未创建的实例（前向引用 holder），但不允许在工厂求值期
//   读取尚未初始化的 services 常量（破坏：ReferenceError 或静默走进 undefined 降级分支）。
// INV-06：平台差异（Pipe 名、Helper 启动参数、/usr/bin/open 冷启）只允许出现在 CUA 段，其它域不得按
//   平台分叉（破坏：远端 Host 复用本地平台假设，产出谁都不连的 socket 路径）。
//
// 生命周期：createLocalServices 同步构建 → 调用方登记 disposer → RPC 开放 → Host 关闭时先
// disposeServiceResourcesAndWait（可等待 Agent 进程树与 Helper），同步版只用于退出兜底。
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
// homedir 仅作全局 CLI 配置探测（hasGlobalCliZCodeCuaServer）的兜底：优先 env.HOME，因为宿主进程
// 可能带着被改写的 HOME（测试沙箱、便携安装），直接取进程默认值会读到错误用户目录并误判能力。
import { join } from "node:path";
import {
  createNodeProviderRuntimePathEnv,
  NodeModelSelectionConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import { getAppConfigDir as resolveAppConfigDir } from "./paths.js";
import {
  createHasExistingLocalTask,
  hasAnyAgentSessionRow,
  resolveAgentSessionDbPath,
} from "./onboarding/localUsageEvidence.js";
import {
  buildLocalMediaPreviewUrl,
  type DynamicWorkflowMode,
  type ProviderProvisioningTrigger,
} from "@zcode/shared";

export {
// 对外 re-export 段：装配入口与类型契约各留一条出口，desktop main / server 只依赖本模块即可，
// 无需感知内部目录结构。新增导出请归并到对应分节注释下，避免此处退化成无注释的符号墙。
// 约束：本文件含 node:* 依赖，只允许 Node 侧入口引用，browser-safe 根入口不得转发任何符号。
  materializeZCodeBuiltinProviderConfig,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { randomUUID } from "node:crypto";
import { getAppConfigDir as getContentAppConfigDir } from "#src/paths.js";
import { ICloudContentService } from "#src/cloud-content/cloudContent.js";
import { createCloudContentService } from "#src/cloud-content/cloudContentService.js";
import { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";
import { createMarketingTouchService } from "#src/marketing-touch/marketingTouchService.js";
import { createMarketingAssetRegistry } from "#src/marketing-touch/marketingAssetRegistry.js";
import type { IChannel } from "@zcode/rpc";
import {
  readTopicResourceFromRelay,
  validateTopicResourceFromRelay,
} from "./zcode-agent/topicResourceRelayClient.js";
export {
  createTopicResourcePeers,
  type TopicResourcePeers,
} from "./zcode-agent/topicResourcePeers.js";
export { createTopicResourceRelayChannel } from "./zcode-agent/topicResourceRelayChannel.js";

// topic-resource 三件套（peers / relay channel / relay client）是 Agent 会话与 Desktop 之间的私有回查
// 通道，走已鉴权的 stdio 连接，不属于通用 RPC 服务面，因此只导出工厂与类型、不注册进集合。
// 文件搜索/预览/媒体这一类能力必须由 Host 提供：路径越界判定依赖本机真实根目录，
// 远端链路只能通过 host 反向请求，不能由 renderer 自行拼路径。
export { createFileService } from "./file/fileService.js";
export {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type HostResourceUsageAgent,
  type ProcessResourceSample,
  type ProcessResourceSampler,
// 进程资源采样器按 pid 归属整棵子进程树，供 Host 展示 Agent 真实占用；采样是只读旁路，
// 不得参与调度或健康判定，否则会把诊断抖动放大成任务失败。
} from "./process/processResourceSampler.js";
// 预览服务只签发受限 URL，不返回文件内容；本地路径必须先由 Main 登记授权（见 createLocalServices 注入点）。
export { createMediaPreviewService } from "./media-preview/mediaPreview.js";
export { createContentBundleCache } from "#src/cloud-content/contentBundleCache.js";
export type { ContentBundle } from "#src/cloud-content/contentBundleCache.js";
export type { CreateFileServiceOptions } from "./file/fileService.js";
export {
  defaultWorkspaceFileSearchFilter,
  type WorkspaceFileSearchDecision,
  type WorkspaceFileSearchEntry,
  type WorkspaceFileSearchFilter,
} from "./file/workspaceFileMentionFilter.js";
export {
  createFsFaultInjector,
  getProcessFsFaultInjector,
  maybeThrowInjectedFsFault,
  parseFsFaultRulesFromEnvValue,
  resetProcessFsFaultInjectorForTests,
  setFsFaultInjectorForTests,
  ZCODE_E2E_FS_FAULTS_ALLOW_ENV,
  ZCODE_E2E_FS_FAULTS_ENV,
} from "./fs/fsFaultInjection.js";
export type {
  FsFaultCheckInput,
  FsFaultHit,
  FsFaultInjector,
  FsFaultOperation,
  FsFaultRuleConfig,
  InjectedFsFaultError,
} from "./fs/fsFaultInjection.js";
export {
  setDataBaseDir,
  getDataBaseDir,
  getZCodeDataRootDir,
  getConversationWorkspaceDir,
  getAppConfigDir,
  getExportLogStageDir,
  getExportLogDir,
  getFeedbackRootDir,
  getFeedbackAttachmentDir,
  getFeedbackLogArchiveDir,
  getGitCheckpointIndexRootDir,
  copyDataDirectory,
  validateDataBaseDirTarget,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "./paths.js";
// Git 相关服务都以「目标 workspace 的 cwd」为作用域：commit message 生成会回调 Agent 生成文本，
// 但 diff/stage 等操作必须在本机 git 上完成，禁止把仓库路径转发给远端执行。
export { createGitService } from "./git/gitService.js";
export { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
// checkpoint 与 git 提交是两条链：checkpoint 只写索引目录（可回滚到任意 turn），
// 不会改动用户分支；两者共享同一个 workspace 解析结果。
export { createGitCheckpointService } from "./git/gitCheckpointService.js";
// 系统 / 终端服务暴露的是「本机」事实（homedir、shell、进程）。远端 Host 上它们代表远端机器，
// 因此任何消费方都必须把结果视为「当前 Host 的机器」而不是「用户面前的机器」。
export { createSystemService } from "./system/systemService.js";
// SSH 别名解析只读本机 ssh config，用于远端 Host 的地址补全；解析失败只影响展示，不影响连接。
export { listSSHConfigAliasesFromLocalConfig } from "./system/sshConfigAlias.js";
// 终端服务持有子进程与 PTY，属于必须被 dispose 的资源；它读取 settingService 决定默认 shell，
// 所以设置注入必须早于它构造（注册顺序见 createLocalServices）。
export { createTerminalService } from "./terminal/terminalService.js";
export {
  createSettingService,
  createSettingServiceWithMigrations,
} from "./setting/settingService.js";
export { createCredentialService } from "./credential/credentialService.js";
// 广播服务由 Host 注入 parentPort 才能跨窗口；未注入时为空实现，保证同一份代码在 CLI 侧可复用。
export { createBroadcastService } from "./broadcast/broadcastService.js";
// Agent / Task / Session 三层：agent 负责子进程与协议，task adapter 负责 task 词映射，
// session 负责 turn 生命周期与落库。三者的接口都从这里导出，装配方按接口取用、不直接 new。
export { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
export { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
// session 服务是 turn 生命周期与流式输出的所有者：它向上暴露事件、向下驱动 agent，
// 所有终态都必须经它进入 syncer 落库，否则侧边栏状态会停在 running。
export { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
export {
  resolveDefaultZCodeAgentCommand,
  ZCodeAgentProcessManager,
} from "./zcode-agent/zcodeAgentProcessManager.js";
export type {
  ZCodeAgentCommand,
  ZCodeAgentCommandResolver,
  ZCodeAgentCommandResolverContext,
  ZCodeAgentProcessManagerOptions,
} from "./zcode-agent/zcodeAgentProcessManager.js";
// 协议三件套（client / transport / stdio）是 Agent 通信的底层：协议改动必须同步更新 shared 的
// 运行时 schema，否则 host 与 agent 版本错配时会读到未校验的字段。
export { ZCodeProtocolClient } from "./zcode-agent/zcodeProtocolClient.js";
export type { ZCodeProtocolTransport } from "./zcode-agent/zcodeProtocolTransport.js";
export { ZCodeStdioTransport } from "./zcode-agent/zcodeStdioTransport.js";
export {
  getZCodeStdioTapDevLogDir,
  readZCodeStdioTapDevState,
  setZCodeStdioTapDevEnabled,
} from "./zcode-agent/zcodeStdioTapDevConfig.js";
export type { ZCodeStdioTapDevState } from "@zcode/shared";
export {
  createCuaHelperInstaller,
  requestHelperAccessibilityPermissionViaLaunchServices,
  requestHelperScreenRecordingPermissionViaLaunchServices,
} from "./cua-permission-broker/index.js";
export {
  canonicalizeCuaHelperInstallerOptions,
  createCanonicalCuaHelperInstaller,
  normalizeCuaHelperArch,
  normalizeCuaHelperArchs,
} from "./cua-permission-broker/cuaHelperInstaller.js";
export type {
  CuaHelperInstaller,
  CuaHelperInstallerOptions,
} from "./cua-permission-broker/index.js";
// 项目/workspace 导航是纯读投影：它只组合已知目录与身份，不在导航过程中建立连接或启动会话。
export { createProjectWorkspaceNavigation } from "#src/project-workspace-navigation/index.js";
// Bot 服务跨「本机配置」与「远端 workspace 绑定」两侧，因此它同时依赖 repo、项目服务与凭据；
// 它的写入会派生后台任务，只在本地权威侧用于启动期扫描（见 runStartupBackgroundTasks）。
export { createBotsService } from "./bots/botsService.js";
export { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
// OAuth 服务只处理登录/退出与凭据校验请求的分类，不直接读写磁盘：凭据存储统一交给 credentialService。
export { createOAuthService } from "./oauth/oauthService.js";
export { createOAuthProviderLogoutHandler } from "./oauth/oauthProviderLogout.js";
// OAuth 仓库只封装凭据 key 的命名与解析，不直接加密：加密/解密统一由 credentialService 完成。
export { OAuthCredentialRepo } from "./oauth/repo/oauthCredentialRepo.js";
// 遥测核心只做事件采集与设备标识，userId/授权头由本文件末尾的三个 loader 提供（均为只读、失败降级）。
export { createTelemetryCore, ensureTelemetryDeviceMid } from "./telemetry/telemetryCore.js";
export type { EnsureTelemetryDeviceMidOptions } from "./telemetry/telemetryCore.js";
export type { AccountRequestAuthResolver } from "./model-provider/accountProviderRequestAuthService.js";
// 账号凭据存储把「provider 材料」落在 credentialService 的键空间里，
// 对外只暴露按 family 读取的接口，避免调用方直接拼 oauth:* 键名。
export { createAccountProviderCredentialStore } from "./model-provider/accountProviderCredentialStore.js";
export type {
  AccountProviderCredentialStore,
  AccountProviderCredentialStoreOptions,
} from "./model-provider/accountProviderCredentialStore.js";
// 旧个人配置导入只在新 Personal 配置不存在时执行，并保留旧文件以便回滚；它不是迁移的唯一入口。
export { importLegacyPersonalProviderConfig } from "./model-provider/legacyPersonalProviderConfigImporter.js";
export {
  createAccountProviderConfigSource,
  createAccountProviderConnectionResolver,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "./model-provider/accountProviderConnectionResolver.js";
export { bindAccountProviderInvalidation } from "./model-provider/accountProviderInvalidation.js";
export type {
  AccountProviderConfigSourceOptions,
  AccountProviderConnectionResolverOptions,
  AccountProviderConnectionSettings,
  AccountProviderFamilyAvailabilityInput,
  AccountProviderFamilyAvailabilityResolver,
  CodingPlanFamilyAvailabilityResolverOptions,
} from "./model-provider/accountProviderConnectionResolver.js";
export {
// Provider 配置运行时（config）与 Provider 运行时（runtime）分两层导出：前者管文件与合并，
// 后者管 Registry 与模型选择；装配方通常两个都要，但职责边界不能混。
  createProviderConfigRuntime,
  ProviderConfigRuntime,
} from "./model-provider/providerConfigRuntime.js";
export type { ProviderConfigRuntimeOptions } from "./model-provider/providerConfigRuntime.js";
export {
  createProviderRuntime,
  createProviderRuntimeFromConfigRuntime,
  EmptyAccountProviderConfigSource,
  ProviderRuntime,
} from "./model-provider/providerRuntime.js";
export type {
  ProviderRuntimeDependencies,
  ProviderRuntimeOptions,
} from "./model-provider/providerRuntime.js";
export {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
  type ProviderProvisioningSourceOptions,
} from "./model-provider/providerProvisioningSource.js";
export {
  createProviderProvisioningTarget,
  type ProviderProvisioningTargetOptions,
} from "./model-provider/providerProvisioningTarget.js";
export {
  createModelSelectionService,
  createProviderSettingsService,
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
// 账号请求鉴权服务对外只暴露「按当前 access 解析请求身份」，内部组合个人/团队/项目三条材料来源。
export { createAccountRequestAuthService } from "./model-provider/accountRequestAuthService.js";
export type { IAccountRequestAuthService } from "./model-provider/accountRequestAuthService.js";
export { createAccountProviderRequestAuthService } from "./model-provider/accountProviderRequestAuthService.js";
export {
  resolveAccountTeamPlanRuntimeApiKey,
  resolveAccountTeamPlanRuntimeMaterial,
} from "./model-provider/accountProviderTeamPlanRequestKey.js";
export { createAccountProjectTokenClient } from "./model-provider/accountProjectTokenClient.js";
export { createAccountProviderCredentialService } from "./model-provider/accountProviderCredentialService.js";
// SourceServer workspace 服务维护「远端 serverId + 路径 → 稳定身份」的映射，是远端会话身份隔离的基础。
export { createSourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspaceService.js";
export {
  SourceServerWorkspaceIdentityChannelServer,
  SourceServerWorkspaceIdentityMapper,
} from "./source-server-workspace/sourceServerWorkspaceIdentityChannelServer.js";
export {
  SourceServerWorkspaceAliasRepo,
  SourceServerWorkspaceIdentityConflictError,
} from "./session/sourceServerWorkspaceAliasRepo.js";
// 身份迁移是「路径 → workspaceIdentity」的一次性数据修正，必须支持重复执行（幂等），
// 因为它会在不同 Host 的启动路径上各自触发一次。
export { migrateControllerRemoteWorkspaceIdentity } from "./session/controllerRemoteIdentityMigration.js";
export type {
  ControllerRemoteIdentityMigrationOptions,
  ControllerRemoteIdentityMigrationReport,
} from "./session/controllerRemoteIdentityMigration.js";
// 用量统计同时依赖账号鉴权与官方 MCP 凭证解析：两处必须共用同一份解析结果，否则统计口径与实际请求身份不一致。
export { createUsageStatsService } from "./usage-stats/usageStatsService.js";
// Storage：service 与 adapters 工厂；desktop host 负责组装（Worker runner 在 desktop 包内）
export { createStorageService } from "./storage/app/storageService.js";
// Storage 域按 app / contract / adapters 三层导出：装配方只拿服务接口与端口类型，扫描与清理实现留在
// adapters，防止 Host 直接触碰文件系统语义（清理范围与根目录解析必须只有一个事实源）。
// 组装方与工厂在同一入口取类型，避免 desktop main 为服务接口再引 browser 入口。
export type { IStorageService } from "./storage/contract.js";
export type {
  FsCleanerPort as StorageFsCleanerPort,
  RootsResolverPort as StorageRootsResolverPort,
  ScanRunnerPort as StorageScanRunnerPort,
  StorageScanProgress,
  StorageScanRunRequest,
} from "./storage/app/ports.js";
export { createFsStorageCleaner } from "./storage/adapters/fsCleaner.js";
export {
  createStorageRootsResolver,
  resolveStorageRoots,
} from "./storage/adapters/rootsResolver.js";
export { createFsVolumeProbe } from "./storage/adapters/volumeProbe.js";
export { runStorageScan } from "./storage/adapters/inProcessScanRunner.js";
// 订阅服务负责「当前账号能用哪些 Coding Plan 能力」：闲时任务、动态工作流、加速卡都从这里取能力视图，
// 不各自去推断账号套餐。
export { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
// 客户端配置与场景服务都以 Host 解析出的 endpoint origin 为请求上下文，保证自定义端点上配置跟随生效。
export { createClientConfigService } from "./client-config/clientConfigService.js";
export { createClientScenesService } from "./client-scenes/clientScenesService.js";
// Skill / 子 Agent / 命令 / Hooks / 插件都按 workspace 维度扫描本地目录，
// 因此它们都只在本机执行文件 IO，再由 Agent 侧消费结果。
export { createSkillsService } from "./skills/skillsService.js";
// 各 sync 服务（skill / mcp / plugin）职责一致：把本地声明推给远端可见集，失败可重入、不删除本地。
export { createSkillSyncService } from "./skill-sync/skillSyncService.js";
// MCP / Skill / Plugin 三套同步服务共享「本地声明 → 远端可见」的模型：
// Host 只负责枚举与同步触发，真实状态检查仍在 Agent 进程内完成。
export { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
// 插件同步必须注册进集合（见注册链注释）：远端接入依赖该频道枚举本地候选，缺失会静默超时。
export { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
// 插件服务负责 workspace 级插件清单与启用状态；真正的插件进程由 Agent 侧按清单拉起，host 不代管。
export { createPluginsService } from "./plugins/pluginsService.js";
// 插件管理是设置页插件域的薄服务：旧协议词的 host 侧唯一消费点，不承载安装/卸载等重逻辑。
export { createPluginManagementService } from "./plugins/pluginManagementService.js";
// 子 Agent 服务同时暴露「配置读取」与「运行时快照准备」两个面：后者必须在 Agent spawn 前调用。
export { createSubagentsService } from "./subagents/subagentsService.js";
// 自定义命令是纯文本模板 + 参数替换，解析与执行都在 Agent 侧；host 只负责按 workspace 枚举文件。
export { createCommandsService } from "./commands/commandsService.js";
// Hooks 的可执行文件信任由会话运行期授予，host 侧只做清单与授权转发（见 zcodeAgentService 注入）。
export { createHooksService } from "./hooks/hooksService.js";
// 记忆 / 输出风格 / 设置同步属于纯配置投影：构造无 IO，读写都落在 workspace 或设置文件上。
export { createMemoryService } from "./memory/memoryService.js";
// 输出风格是设置投影的只读视图，不持有状态；切换风格写设置，由设置变更事件驱动重新读取。
export { createOutputStyleService } from "./output-style/outputStyleService.js";
// 设置同步服务负责把本地设置与远端订阅对齐，冲突解决依赖 settingService 的版本；它不自己写设置。
export { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
// 诊断归档与反馈服务分开导出：归档是纯文件打包能力，可被崩溃上报等非反馈链路复用，不绑定 API 客户端。
export { createFeedbackDiagnosticArchive } from "./feedback/feedbackLogArchive.js";
// 反馈服务组合 API 客户端、凭据与 OAuth：附件与日志归档走本机文件，提交走同一个 apiClient。
export { createFeedbackService } from "./feedback/feedbackService.js";
export type { CreateFeedbackServiceOptions } from "./feedback/feedbackService.js";
// 提示词附件传输只在本地 Host 成立（读写本机临时文件）；远端 Host 走各自的 artifact 通道。
export { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
export {
// 会话发布产物源分本地/远端两种：本地直接读本机文件并打包，远端必须经 relay 取，不允许越权读本机。
  createLocalConversationShareArtifactSource,
  createRemoteConversationShareArtifactSource,
} from "./conversation-share/conversationShareArtifactSource.js";
// Node API 客户端把所有出站 HTTP 走同一个网络 transport（代理/CA/超时集中管理），
// 并内置 401 分类回调，避免各业务自己判断「这次 401 是登录失效还是业务拒绝」。
export { createNodeApiClient, NodeApiClient } from "./providers/api/nodeApiClient.js";
export {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
export {
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  normalizeRuntimeProcessEnv,
  prepareRuntimeProcessEnvPatch,
} from "./runtime-tools/runtimeCommandEnv.js";

// 定时任务管理与 scheduler 共用同一套 node-only 存储和 cron 语义。
export {
  AutomationRepo,
  DISPATCH_RETRY_BASE_MS,
  DISPATCH_RETRY_CAP_MS,
  DISPATCH_MAX_ATTEMPTS,
  CLAIM_STALE_MS,
  computeRetryAt,
} from "./session/automationRepo.js";
// 定时任务服务与 scheduler 共用 cron 语义与 node-only 存储：非法 cron 在服务层就抛错，
// 不允许把错误表达式写库后由调度器每轮重试。
export { AutomationService, InvalidCronExprError } from "./session/automationService.js";
// 闲时任务与 automation 同库不同表；类型/常量全独立。
// 闲时任务与 automation 同库不同表：类型与常量完全独立，但共享同一份 sqlite 句柄管理约定。
export { OffPeakTaskRepo, OFF_PEAK_CLAIM_STALE_MS } from "./session/offPeakTaskRepo.js";
// host 域终态回填 files_changed 复用现有 task diff 汇总。
export { buildTaskChangeSummary } from "./session/taskChangeSummary.js";
export { OffPeakTaskService } from "./session/offPeakTaskService.js";
export { IOffPeakTaskService } from "./session/offPeakTask.js";
export { IHighspeedCardService } from "./highspeed/highspeedCard.js";
export { createOffPeakServerClient, OffPeakServerError } from "./session/offPeakServerClient.js";
export { isOffPeakMockEnabled, startOffPeakMockGateway } from "./session/offPeakMockGateway.js";
export {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCredentials,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakMockUpstream,
  OffPeakCodingPlanUnavailableError,
  OffPeakCredentialsUnavailableError,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
} from "./session/offPeakRuntimeModel.js";
// 统一日志入口：scope 固定、频率分级（debug/info/warn/error），生产不落高频 debug，
// 因此本文件内的装配期诊断都走 createServiceLogger 而不是 console。
export { createServiceLogger } from "./logger/serviceLogger.js";
export {
  buildOfficialMcpAuthHeaders,
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "./official-mcp/officialMcpCredentials.js";
export {
  computeAutomationNextRunAt,
  computeNextRunAt,
  computeScheduleRuleNextRunAt,
  isOneShotAutomation,
  isValidCronExpr,
} from "./session/automationCron.js";

import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import { SourceServerWorkspaceAliasRepo } from "./session/sourceServerWorkspaceAliasRepo.js";
import { SourceServerWorkspaceIdentityMapper } from "./source-server-workspace/sourceServerWorkspaceIdentityChannelServer.js";
// 以下是「实现侧」导入：与上面纯 re-export 不同，这些符号在本文件内被直接 new / 调用，是装配逻辑的
// 真实依赖。改动这些路径会同时影响导出契约，需一并核对上方的 export 列表。
import { ServiceCollection } from "./collection.js";
import { IFileService } from "./file/file.js";
import { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import { IGitService } from "./git/git.js";
import { IGitCheckpointService } from "./git/gitCheckpoint.js";
import { ISystemService } from "./system/system.js";
import { ITerminalService } from "./terminal/terminal.js";
import { ISettingService } from "./setting/setting.js";
import { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
// onboarding 记录服务刻意不上方 re-export：它的用户证据判定依赖本进程的 tasks-index 与旧版快照目录，
// 属于 Host 装配细节，不应被其它包直接实例化。
import { ICredentialService } from "./credential/credential.js";
import { IBroadcastService } from "./broadcast/broadcast.js";
import { IZCodeTaskService } from "./session/zcodeTaskService.js";
import { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import type { CuaOperationStateReporter } from "./zcode-agent/cuaOperationTurnTracker.js";
import { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import {
  createUnsupportedConversationShareService,
  IConversationShareService,
  type IConversationShareService as IConversationShareServiceType,
} from "./conversation-share/conversationShare.js";
import {
  ConversationShareService,
  conversationShareConnectionScopeFactory,
} from "./conversation-share/conversationShareService.js";
import { createLocalConversationShareArtifactSource } from "./conversation-share/conversationShareArtifactSource.js";
import { ConversationShareHttpClient } from "./conversation-share/conversationShareHttpClient.js";
// 下面一批 import 是各域「接口 token」：注册用符号做 key、消费按符号取实例，保证同一域在不同 Host
// （desktop-local / remote / standalone-server）下可换实现而调用点不变。
import { IBotsService } from "./bots/bots.js";
import { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import { IOAuthService } from "./oauth/oauth.js";
import { ISourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspace.js";
import { IUsageStatsService } from "./usage-stats/usageStats.js";
import { ICodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscription.js";
import { IClientScenesService } from "./client-scenes/clientScenes.js";
import { ISkillsService } from "./skills/skills.js";
import { ISkillSyncService } from "./skill-sync/skillSync.js";
import { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import { IPluginSyncService } from "./plugin-sync/pluginSync.js";
import { IPluginsService } from "./plugins/plugins.js";
import { IPluginManagementService } from "./plugins/pluginManagement.js";
import { ISubagentsService } from "./subagents/subagents.js";
import { ICommandsService } from "./commands/commands.js";
import { IHooksService } from "./hooks/hooks.js";
import { IMemoryService } from "./memory/memory.js";
import { IOutputStyleService } from "./output-style/outputStyle.js";
import { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import { IFeedbackService } from "./feedback/feedback.js";
import { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import { createFileService } from "./file/fileService.js";
import { createMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { WorkspaceFileSearchFilter } from "./file/workspaceFileMentionFilter.js";
import { createGitService } from "./git/gitService.js";
import { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
import { createGitCheckpointService } from "./git/gitCheckpointService.js";
import { createSystemService } from "./system/systemService.js";
import { createTerminalService } from "./terminal/terminalService.js";
import {
  createSettingService,
  createSettingServiceWithMigrations,
} from "./setting/settingService.js";
import { createOnboardingRecordService } from "./onboarding/onboardingRecordService.js";
import { createLegacyTeamOrganizationResolver } from "./model-provider/legacyTeamOrganizationResolver.js";
import { createObservableSettingService } from "./setting/observableSettingService.js";
// 凭据 / 广播 / Agent 三件核心服务：credential 是唯一凭据读写口，broadcast 是唯一跨窗口事件口，
// 其余模块只能经注入拿到接口，禁止直接 new 具体实现，否则失效通知与 dispose 会绕过统一收口。
import { createCredentialService } from "./credential/credentialService.js";
import { createBroadcastService } from "./broadcast/broadcastService.js";
import { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
import type { ZCodeAgentCommandResolver } from "./zcode-agent/zcodeAgentProcessManager.js";
import { buildAgentTelemetrySpawnEnv } from "./zcode-agent/agentTelemetryEnv.js";
import { resolveZCodeAgentPresentationSurface } from "./zcode-agent/zcodeAgentPresentationSurface.js";
import { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
import { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
import { createZCodeTaskIndexSyncer } from "./zcode-agent/zcodeTaskIndexSyncer.js";
import { TaskIndexRepo } from "./session/taskIndexRepo.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import type { AppSettings } from "@zcode/shared";
import { createBotsService } from "./bots/botsService.js";
import { BotsRepo } from "#src/bots/repo.js";
import {
// bot 运行时同时需要 remoteProjectService 与窗口级连接表；它在本文件内组装而不导出工厂，因为 connectHost
// 只允许由 Host 装配层注入，导出会让其它调用方误建第二条连接路径。
  createBotProjectRuntime,
  type BotProjectConnection,
} from "#src/bot-project-runtime/index.js";
export type { BotProjectConnection } from "#src/bot-project-runtime/contract.js";
import type { SessionMessageSendRequested } from "#src/session/sessionMailbox.js";
import { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
import { createOAuthService } from "./oauth/oauthService.js";
import {
  isOAuthBusinessRequest,
  resolveOAuthBusinessCredentialValidationRequest,
  isCurrentOAuthCredentialRequest,
} from "#src/oauth/oauthUnauthorizedRequest.js";
import { createOAuthProviderLogoutHandler } from "./oauth/oauthProviderLogout.js";
import { OAuthCredentialRepo } from "./oauth/repo/oauthCredentialRepo.js";
import { readLegacyZCodeConfigProviders } from "./model-provider/legacyZCodeConfigProviderReader.js";
import { resolveAccountTeamPlanRuntimeMaterial } from "./model-provider/accountProviderTeamPlanRequestKey.js";
import { createAccountProviderCredentialStore } from "./model-provider/accountProviderCredentialStore.js";
import { createAccountProviderCredentialService } from "./model-provider/accountProviderCredentialService.js";
import { createAccountProviderRequestAuthService } from "./model-provider/accountProviderRequestAuthService.js";
import {
  createAccountProviderConfigSource,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "./model-provider/accountProviderConnectionResolver.js";
import { bindAccountProviderInvalidation } from "./model-provider/accountProviderInvalidation.js";
import { AccountProviderApiClient } from "./model-provider/accountProviderApiClient.js";
import { createAccountProjectTokenClient } from "./model-provider/accountProjectTokenClient.js";
import { AccountProviderApiKeyResolver } from "./model-provider/accountProviderApiKeyResolver.js";
import { createProviderConfigRuntime } from "./model-provider/providerConfigRuntime.js";
import { fetchZCodeBuiltinRemoteRelease } from "./model-provider/zcodeBuiltinRemoteConfig.js";
import {
  createProviderRuntimeFromConfigRuntime,
  type ProviderRuntime,
} from "./model-provider/providerRuntime.js";
import {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import { createProviderSettingsConnectivityTester } from "./model-provider/providerSettingsConnectivity.js";
import {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
} from "./model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "./model-provider/providerProvisioningTarget.js";
import { IProviderProvisioningTargetService } from "./model-provider/providerProvisioning.js";
import { buildOffPeakModelSelectionView } from "./model-provider/offPeakModelSelectionView.js";
import { resolveClientConfigPlatform } from "./runtime-tools/clientPlatform.js";
import {
  createAccountRequestAuthService,
  type IAccountRequestAuthService,
} from "./model-provider/accountRequestAuthService.js";
import { createSourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspaceService.js";
import { createUsageStatsService } from "./usage-stats/usageStatsService.js";
import { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
import { createClientConfigService } from "./client-config/clientConfigService.js";
import { IClientConfigService } from "./client-config/clientConfig.js";
import { createClientScenesService } from "./client-scenes/clientScenesService.js";
import { createSkillsService } from "./skills/skillsService.js";
import { createSkillSyncService } from "./skill-sync/skillSyncService.js";
import { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
import {
  IPluginUiAppToolsService,
  IPluginUiSamplingService,
  createPluginUiSamplingService,
  IPluginUiBridgeService,
  createPluginUiAppToolsService,
  createPluginUiBridgeService,
} from "./plugin-ui-bridge/index.js";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
import { createPluginsService } from "./plugins/pluginsService.js";
import { createPluginManagementService } from "./plugins/pluginManagementService.js";
import { createSubagentsService } from "./subagents/subagentsService.js";
import { createCommandsService } from "./commands/commandsService.js";
import { createHooksService } from "./hooks/hooksService.js";
import { createMemoryService } from "./memory/memoryService.js";
import { createOutputStyleService } from "./output-style/outputStyleService.js";
import { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
import {
  createFeedbackService,
  type CreateFeedbackServiceOptions,
} from "./feedback/feedbackService.js";
import { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
import { createNodeApiClient } from "./providers/api/nodeApiClient.js";
import {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
import type {
  RuntimeProcessLifecycleReporter,
  RuntimeTaskReporter,
} from "#src/process/runtimeProcessLifecycle.js";
import { initializeRuntimeProcessEnv } from "./runtime-tools/runtimeCommandEnv.js";
import {
  buildAgentEndpointOriginEnv,
  buildAgentRuntimeEnv,
} from "./runtime-tools/agentProxyEnv.js";
import { ensureAppCaCert } from "./runtime-tools/appCaCert.js";
import { buildHelperOpenArgs, isCuaLocalDevelopmentRuntime } from "@zcode/zcode-cua/broker/server";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import { IOffPeakTaskService } from "./session/offPeakTask.js";
import type { HighspeedMockScenario } from "@zcode/shared";
import { IHighspeedCardService } from "./highspeed/highspeedCard.js";
import {
  buildHighspeedCodingPlanAuthHeaders,
  HighspeedCardService,
  createHighspeedHttpTransport,
} from "./highspeed/highspeedCardService.js";
import { createHighspeedMockTransport } from "./highspeed/highspeedMockTransport.js";
import { OffPeakTaskService } from "./session/offPeakTaskService.js";
import { OffPeakTaskRepo } from "./session/offPeakTaskRepo.js";
import { createOffPeakServerClient } from "./session/offPeakServerClient.js";
import {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCredentials,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakMockUpstream,
} from "./session/offPeakRuntimeModel.js";
import {
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "./official-mcp/officialMcpCredentials.js";
import {
  createOfficialMcpTrustedOriginRegistry,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
} from "@zcode/shared";
import {
  BROKER_SOCKET_ENV,
  BROKER_UNAVAILABLE_ENV,
  createCuaPipSessionService,
  createCuaProductMcpServerResolver,
  createProductCuaHelperHost,
  CuaHelperLifecycleManager,
  ICuaPermissionService,
  ICuaPipSessionService,
  isOfficialCuaPluginEnabledForWorkspace,
  isPotentialZCodeCuaAgentMcpServer,
  isScreenCaptureProbeSuccess,
  reapOrphanedHelpers,
  resolveStandaloneStatusLaunchAppPath,
  shouldRunCuaScreenCaptureProbe,
  type CuaHelperHost,
  type CuaHelperTransportRestartOptions,
  type CuaHelperTransportRestartResult,
  type ManagedCuaProductHelperHost,
  type CuaProductMcpServerResolver,
  type CuaProductMcpServerResolverContext,
  type CuaPermissionRestartOptions,
  type CuaPermissionRestartResult,
  type CuaPermissionState,
  type CuaPermissionStatusQueryOptions,
  type CuaPermissionStatusResult,
} from "#src/cua-permission-broker/index.js";
import {
  resolveWindowsCuaRuntime,
  WindowsCuaDevRuntimeResolutionError,
  type WindowsCuaRuntime,
} from "#src/cua-permission-broker/windowsCuaDevRuntime.js";
import { createCanonicalCuaHelperInstaller } from "./cua-permission-broker/cuaHelperInstaller.js";
import { WindowsCuaHelperHost } from "#src/cua-permission-broker/windowsCuaDevHelperHost.js";
import {
  getStableCuaPipeName,
  resolveStableCuaWinRecipe,
} from "#src/cua-permission-broker/stableCuaTransport.js";
import { HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import { resolveBrokerSocketPath } from "@zcode/zcode-cua/broker/socketPath";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
  formatLogPrefix,
  isCredentialDecryptError,
  isStartPlanModelProviderId,
  OFF_PEAK_PROVIDER_IDS,
  BIGMODEL_PROVIDER_ID,
  type ProviderFamilyDomain,
  type ServiceAuthorityMode,
  resolveRuntimeZCodeEndpointOrigin,
  resolveSafeTelemetryHostname,
  type BrowserBackendDescriptor,
  type BrowserClientMode,
  type BrowserCommand,
  isZCodeCuaMcpCommand,
  isZCodeCuaMcpPackageArg,
  isZCodeCuaInternalFeatureEnabled,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  getCapturedZCodeAgentTelemetryEnv,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZAI_PROVIDER_ID,
  zcodeAccountAccessSchema,
  zcodeProviderAccountAccessSchema,
  ZCODE_VERSION,
  ZCODE_ENV,
  buildRuntimeZCodeApiUrl,
} from "@zcode/shared";

// 这些 conversation-share 实现依赖 Node 文件系统；仅通过 @zcode/services/node 暴露，
// 防止 browser-safe 根入口把 node:* 依赖带进 renderer。
export {
  ConversationShareService,
  ConversationShareHttpClient,
  conversationShareConnectionScopeFactory,
};

import { createPluginUiAccountBindings } from "./plugin-ui-bridge/instanceAccounts.js";
// 资源释放的鸭子类型契约：Host 里混着域服务、长驻进程宿主与纯函数工厂，统一用这两个最小接口识别
// 「谁需要被释放」，避免给每个域都补一层无意义的基类。识别失败不会抛错，只会让该资源被跳过，
// 因此新增需要释放的实例时必须显式实现 disposeAll / disposeAllAndWait（漏实现 = 静默泄漏）。
interface ServiceWithDisposeAll {
  disposeAll: () => void;
}

interface ServiceWithDisposeAllAndWait {
  disposeAllAndWait: () => Promise<void>;
}

// Bug A: the Helper's first cold launch (large Node SEA + first-time Gatekeeper/notarization
// assessment) routinely exceeds the old 5s health budget; warm it is <1s. Give the cold path
// plenty of headroom.
// 冷启动预算必须覆盖首次 Gatekeeper/公证评估（实测常超 5s），热启动 <1s；取 30s 是「不误杀冷启动」
// 与「不让设置页无限转圈」之间的折中。调小会把首次使用者的授权流程直接判成失败。
const CUA_HELPER_HEALTH_TIMEOUT_MS = 30_000;

type DefaultCuaProductHelper = {
  host: ManagedCuaProductHelperHost;
  macPermissionHost?: CuaHelperHost;
  resolver: CuaProductMcpServerResolver;
};

type ManagedDefaultCuaProductHelper = {
  helper: DefaultCuaProductHelper;
  seedContext?: CuaProductMcpServerResolverContext;
};

// 这两个类型守卫刻意写成「属性存在且为函数」而不是 instanceof：服务实现来自不同包甚至不同 bundle，
// 跨 bundle 的类身份不可靠，按结构判定才能在同一进程里同时接纳本包与注入的替身实现。
function hasDisposeAll(instance: unknown): instance is ServiceWithDisposeAll {
  return (
    typeof instance === "object" &&
    instance !== null &&
    "disposeAll" in instance &&
    typeof (instance as { disposeAll?: unknown }).disposeAll === "function"
  );
}

function hasDisposeAllAndWait(instance: unknown): instance is ServiceWithDisposeAllAndWait {
  return (
    typeof instance === "object" &&
    instance !== null &&
    typeof (instance as { disposeAllAndWait?: unknown }).disposeAllAndWait === "function"
  );
}

interface ManagedCuaHelperHostDispose {
  stop(): Promise<void>;
}

// 默认 Computer Use Helper 是长生命周期的独立 TCC 授权进程（持 broker socket + Accessibility/Screen Recording）。
// 它不是 IPC 服务，不进 ServiceCollection 的 disposeAll 列表，但 host 释放时必须显式终止它，否则会以
// 已授权主体常驻、甚至在 services 重建时再起一个 → 多实例/孤儿/权限主体泄漏。用与 ServiceCollection 绑定
// 的 WeakMap 侧表登记，dispose 时统一终止（best-effort，不阻断其它资源回收）。
const managedCuaHelperHosts = new WeakMap<ServiceCollection, ManagedCuaHelperHostDispose>();
const providerRuntimes = new WeakMap<ServiceCollection, ProviderRuntime>();
const providerProvisioningSources = new WeakMap<ServiceCollection, ProviderProvisioningSource>();
const providerProvisioningTriggerDisposers = new WeakMap<
  ServiceCollection,
  readonly (() => void)[]
>();
// 自动归档定时扫描器不是 IPC 服务，随 services 释放时停掉定时器与设置监听。
const taskAutoArchiveDisposers = new WeakMap<ServiceCollection, () => void>();
// TaskIndexRepo / OffPeakTaskRepo 等各自持有 tasks-index.sqlite 的连接句柄；
// dispose 链必须统一关闭：Windows 上句柄悬着会让宿主回收后临时目录 rm 撞 EBUSY
// （stdioDesktopPresentationSurface 单测稳定复现），Linux 的 unlink-while-open 语义掩盖了泄漏。
// 与其它侧表一样按 ServiceCollection 登记并在 dispose 时统一 close。
const sharedSqliteRepos = new WeakMap<ServiceCollection, ReadonlyArray<{ close(): void }>>();
const accountRequestAuthServices = new WeakMap<ServiceCollection, IAccountRequestAuthService>();
export type OffPeakRequestAuthBuilder = (
  ticketId: string,
) => Promise<{ apiKey: string; headers: Record<string, string>; accountScope?: string }>;
const offPeakRequestAuthBuilders = new WeakMap<ServiceCollection, OffPeakRequestAuthBuilder>();

/** Local Host 进程内能力；不会随 ServiceCollection 暴露到通用 RPC Channel。 */
// 以下三个 getter 是 Host 私有能力的「进程内取用口」：它们不注册成 RPC 服务，只给同进程的 Agent
// 适配层或 desktop main 用。任何把返回值序列化进响应体的改动都等于把凭据面暴露给上层。
export function getAccountRequestAuthService(
  services: ServiceCollection,
): IAccountRequestAuthService | undefined {
  return accountRequestAuthServices.get(services);
}

/** Local Host 进程内的 Provisioning Source；不会把凭据通过通用 RPC 暴露给 Renderer。 */
export function getProviderProvisioningSource(
  services: ServiceCollection,
): ProviderProvisioningSource | undefined {
  return providerProvisioningSources.get(services);
}

/** Local Host 私有的闲时请求鉴权装配；复用正式 Registry/Account Access 解析，不进入 RPC。 */
export function getOffPeakRequestAuthBuilder(
// 闲时请求鉴权复用正式 Registry/Account Access 解析：若另起一套判定，会出现同账号在两条链路上
// 得到不同 family/provider 的结论，闲时任务被网关 401 而普通请求正常。
  services: ServiceCollection,
): OffPeakRequestAuthBuilder | undefined {
  return offPeakRequestAuthBuilders.get(services);
}
const managedHostApiNetworkTransports = new WeakMap<ServiceCollection, HostApiNetworkTransport>();

// [资源] 登记语义是「覆盖式」：同一 ServiceCollection 只保留最后一次登记的 host。host 生命周期由
// createLocalServices 独占，重复登记说明装配被调用了两次，此时保留最新者、旧者由调用方自行停止。
export function registerManagedCuaHelperHostForDispose(
  services: ServiceCollection,
  host: ManagedCuaHelperHostDispose,
): void {
  managedCuaHelperHosts.set(services, host);
}

export function registerHostApiNetworkTransportForDispose(
  services: ServiceCollection,
  transport: HostApiNetworkTransport,
): void {
  managedHostApiNetworkTransports.set(services, transport);
}

// 这是纯环境/平台判定，不含任何宿主身份条件；宿主身份过滤在 shouldCreateDefaultCuaProductHelper。
// 两层判定分开的效果：环境关闭时连日志与探测都不产生，而身份不符时只是不创建，仍可响应状态查询。
export function shouldEnableDefaultCuaProductHelper(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): boolean {
  // CUA 已随正式版默认开启（isZCodeCuaInternalFeatureEnabled 默认 ON，仅显式 0/false/off 关闭；2026-08 注释更正——旧注释称默认关闭已过期）。显式开启后 macOS 使用既有产品 Helper，Windows 使用安装包内 runtime；
  // 两端都保持按需启动。关闭时不创建 host、不探测资源、不产生子进程或权限提示。
  const env = options.env ?? process.env;
  if (!isZCodeCuaInternalFeatureEnabled(env)) return false;
  const platform = options.platform ?? process.platform;
  return platform === "darwin" || platform === "win32";
}

/**
 * 是否在当前 host 创建默认 CUA product Helper。Computer Use Helper 只能由**桌面本地** authority 创建：
 * - desktop-attached-remote 与 standalone-server 都绝不自动创建，避免远端 workspace 在错误的
 *   host 上启动 Helper，破坏 shared-host attachment 与权限边界；
 * - 已显式注入 resolver 时不重复创建。
 * 平台/环境层面的启用与否另由 shouldEnableDefaultCuaProductHelper 决定。
 */
// [权衡] 这里把四个条件写成单条合取而非分散 if：调用点只有一处（lifecycle acquire 的 isAdmitted），
// 集中成纯函数后被单测穷举的代价最低，也避免「acquire 已通过、create 又拒绝」产生的空代际。
export function shouldCreateDefaultCuaProductHelper(opts: {
  serviceAuthorityMode?: ServiceAuthorityMode;
  hasRemoteWorkspaceIdentity?: boolean;
  hasInjectedResolver: boolean;
  hasBuiltInCuaPlugin: boolean;
}): boolean {
  return (
    opts.hasBuiltInCuaPlugin &&
    opts.serviceAuthorityMode === "desktop-local" &&
    !opts.hasRemoteWorkspaceIdentity &&
    !opts.hasInjectedResolver
  );
}

export function shouldUseCuaPermissionService(opts: {
  platform?: NodeJS.Platform;
  cuaEnabled: boolean;
}): boolean {
  const platform = opts.platform ?? process.platform;
  return (platform === "darwin" || platform === "win32") && opts.cuaEnabled;
}

// 常驻策略恒定返回 true：开关只门控新的 Agent admission，不能在关闭瞬间回收仍被已有会话复用的
// Helper（回收会让进行中的 CUA turn 断流）。真正的回收点只有 Host/App dispose。
export function shouldRetainDefaultCuaProductHelper(): boolean {
  // CUA 开关只门控后续 Agent admission；已创建的 Helper 只在 Host/App dispose 时停止。
  return true;
}

export function shouldEnableCuaOperationStateReporter(opts: {
  serviceAuthorityMode?: ServiceAuthorityMode;
  hasReporter: boolean;
}): boolean {
  // CUA 操作状态属于物理桌面投影；远端 workspace/server 不得把自己的 turn 投影到本机屏幕。
  return opts.hasReporter && opts.serviceAuthorityMode === "desktop-local";
}

// [失败路径] 探针只回答「现在能不能真的抓到像素」，因此任何异常都收敛成 false 而不是抛出：
// 调用方是设置页刷新，抛错会把一次可重试的探测变成整页报错。
export async function runCuaScreenCaptureReadinessProbe(
  host: Pick<CuaHelperHost, "queryScreenCaptureProbe">,
  screenRecording: "granted" | "denied" | "unknown",
  queryOptions?: CuaPermissionStatusQueryOptions,
): Promise<boolean> {
  if (!shouldRunCuaScreenCaptureProbe(screenRecording, queryOptions)) {
    return false;
  }
  try {
    return isScreenCaptureProbeSuccess(await host.queryScreenCaptureProbe());
  } catch {
    return false;
  }
}

/**
 * Screen Recording 的展示态取值：优先短命 Helper 读到的 TCC 真值，拿不到才沿用常驻 Helper 的报告。
 *
 * 为什么不能直接信常驻 Helper：macOS 撤销 Screen Recording 对**已运行进程**不生效 ——
 * 进程在退出前保留已获得的录屏能力，`CGPreflightScreenCaptureAccess()` 也继续返回撤销前的值。
 * 于是用户在系统设置里关掉授权后，常驻 broker Helper 会一直报 granted 直到它自己重启，
 * 设置页跟着显示「已授权」；而下一次 Helper 重启 CUA 就真的不可用了。
 * 授予方向同样陈旧：刚授权完常驻 Helper 仍可能报 denied。
 *
 * fail-open 是刻意的：预检失败（open 失败 / 超时 / 结果不合法）时沿用报告值，
 * 不比不做预检更糟。硬报 denied 会把已授权用户推进一次无意义的授权引导。
 */
// [权衡] reported === "unknown" 直接短路，不花一次 LaunchServices 冷启：预检走的是同一个 native
// 调用，符号缺失时换进程也只能得到 unknown。其余情况失败一律回退 reported（fail-open）。
export async function resolveCuaScreenRecordingState(
  host: Pick<CuaHelperHost, "queryScreenRecordingPreflight">,
  reported: "granted" | "denied" | "unknown",
): Promise<"granted" | "denied" | "unknown"> {
  // unknown 表示连 CGPreflight 符号都没拿到（macOS 10.15 前）。预检跑的是同一个 native 调用，
  // 换个进程也只会得到 unknown，不值得花一次 LaunchServices 冷启。
  if (reported === "unknown") return reported;
  try {
    return (await host.queryScreenRecordingPreflight()) ?? reported;
  } catch {
    return reported;
  }
}

// 动态 resolver 的价值是「开关可变」：插件可在运行期被关闭，此时必须立刻停止健康检查与重启，
// 而在重新开启后又能懒建。因此它只持有 peek/getResolver 闭包，绝不缓存 host 或 resolver 实例。
export function createDynamicCuaProductMcpServerResolver(options: {
  isPluginEnabled: (context?: CuaProductMcpServerResolverContext) => boolean;
  getResolver: (
    context?: CuaProductMcpServerResolverContext,
  ) => CuaProductMcpServerResolver | undefined | Promise<CuaProductMcpServerResolver | undefined>;
  isResolverCurrent?: (
    resolver: CuaProductMcpServerResolver,
    context?: CuaProductMcpServerResolverContext,
  ) => boolean;
}): CuaProductMcpServerResolver {
  return {
// [并发] delegate 可能跨 Helper start/health 的 await；期间 dispose 会把代际置为 terminal。
// 回来后必须先验 isResolverCurrent，否则会把旧代际刚注入的 socket/token 交给晚到的 Agent。
// 判定失败时只剔除 CUA candidate、保留其它 MCP server，避免一次竞态把整张工具表清空。
    async resolveMcpServers(servers, context) {
      if (!options.isPluginEnabled(context)) return servers;
      const resolver = await options.getResolver(context);
      if (!resolver) return servers;
      const resolved = await resolver.resolveMcpServers(servers, context);
      // delegate 可能跨过 Helper start/health await；dispose 在等待中置 terminal 时，不能把旧代际
      // 刚注入的 socket/token 交给晚到 Agent。移除 CUA candidate，保持其它 MCP 原样。
      return options.isResolverCurrent?.(resolver, context) === false
        ? servers?.filter((server) => !isPotentialZCodeCuaAgentMcpServer(server))
        : resolved;
    },
    async restart() {
      // 委托到底层真实 resolver（由 ICuaPermissionService.restartHelper 经此调用）。
      const resolver = await options.getResolver();
      if (!resolver) {
        throw new Error("ZCode Computer Use is not enabled (plugin off or not product mode).");
      }
      await resolver.restart();
    },
    async restartAfterPermissionGrant(onboardingSessionId) {
      // 授权完成后的 restart 必须保留 session id，才能复用底层的幂等与时序保障。
      const resolver = await options.getResolver();
      if (!resolver) {
        throw new Error("ZCode Computer Use is not enabled (plugin off or not product mode).");
      }
      await resolver.restartAfterPermissionGrant(onboardingSessionId);
    },
  };
}

let orphanHelperReaperHasRun = false;

type CreateDefaultCuaProductHelperOptions = {
  // 转发给 resolver，restart 前用来判断是否有活跃 turn（见 cuaProductMcpResolver.ts）。
  // desktop-local agent service 会提供真实的 CUA turn 状态；其他调用方没有该状态时才回退为 false。
  hasActiveTurn?: () => boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  arch?: NodeJS.Architecture;
  electronVersion?: string;
  resolveWindowsRuntime?: () => Promise<WindowsCuaRuntime>;
  createMacHost?: () => CuaHelperHost;
  createWindowsHost?: (runtime: WindowsCuaRuntime) => ManagedCuaProductHelperHost;
};

/**
 * Windows 侧 Helper 宿主的懒解析包装：把「解析安装包运行时」推迟到首次 start()/checkHealth()，
 * 并把解析结果缓存（含 rejection）。
 *
 * resolveWindowsCuaRuntime 可能因 missing-native-addon、artifact-integrity-mismatch、
 * incompatible-runtime-manifest 等原因失败。若只向调用方抛错而没有诊断记录，设置页的
 * 「未加载」状态无法说明具体原因。因此在这里记录一条带 reason 的
 * error 日志，且因为 rejection 被缓存、日志挂在同一条 promise 链上，重复 start() 不会刷屏。
 * 载荷只有 reason/artifact/errorName/message：解析发生在 mint token 与命名管道之前，天然不含密钥。
 */
// Windows 侧把「解析安装包 runtime」推迟到首次 start()/checkHealth()，因为解析要读文件、校验签名，
// 在 Host 构建期做会拖慢启动且在没有 CUA 需求时白做。解析结果（含 rejection）被缓存，避免重复 IO。
export function createWindowsCuaHelperHost(options: {
  resolveRuntime: () => Promise<WindowsCuaRuntime>;
  createHost: (runtime: WindowsCuaRuntime) => ManagedCuaProductHelperHost;
  logger?: ServiceLogger;
}): ManagedCuaProductHelperHost {
  let host: ManagedCuaProductHelperHost | undefined;
  let resolving: Promise<ManagedCuaProductHelperHost> | undefined;
  let stopped = false;
  let lifecycleEpoch = 0;
  let stopDrain: Promise<void> | undefined;
  const logResolutionFailure = (error: unknown): void => {
    if (!options.logger) return;
    const resolutionError =
      error instanceof WindowsCuaDevRuntimeResolutionError ? error : undefined;
    const artifact = resolutionError?.artifact;
    options.logger.error(undefined, "Windows CUA Helper runtime resolution failed", {
      reason: resolutionError?.reason ?? "unknown",
      ...(artifact ? { artifact } : {}),
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
  };
// [并发] 代际 fence：stop() 同步推进 stopped/epoch，任何在 await 之后继续构造或启动 Helper 的路径
// 都必须先过这里。没有 fence 时 dispose 返回后才 resolve 的 Promise 会拉起一个无人持有的孤儿 Helper，
// 它会以已授权主体常驻，且下次装配会再起一个（多实例、权限主体泄漏）。
  const assertActive = (epoch: number): void => {
    if (stopped || epoch !== lifecycleEpoch) {
      throw new Error("Windows Computer Use Helper startup stopped");
    }
  };
// [并发] resolving 被所有并发调用共享（单飞）：两个 Agent 同时首调 CUA 时只会解析一次 runtime。
// 注意 catch 只包 resolveRuntime，then 里的 assertActive 抛出属 stop 竞态，不能混进同一条诊断日志，
// 否则设置页会把「用户关掉了 CUA」误显示成「运行时不兼容」。
  const getHost = async (epoch: number): Promise<ManagedCuaProductHelperHost> => {
    assertActive(epoch);
    if (host) return host;
    resolving ??= options
      .resolveRuntime()
      // catch 只包住 resolveRuntime 本身：下面 then 里的 assertActive 抛出是 stop() 竞态，不是解析失败，
      // 不能混进同一条诊断日志。
      .catch((error: unknown) => {
        logResolutionFailure(error);
        throw error;
      })
      .then((runtime) => {
        // stop() 会同步推进 epoch。运行时解析完成后必须再次检查，防止 dispose 返回后才构造并启动孤儿 Helper。
        assertActive(epoch);
        const nextHost = options.createHost(runtime);
        assertActive(epoch);
        host = nextHost;
        return nextHost;
      });
    const resolvedHost = await resolving;
    assertActive(epoch);
    return resolvedHost;
  };
  const withActiveHost = async <T>(
    operation: (activeHost: ManagedCuaProductHelperHost) => Promise<T>,
  ): Promise<T> => {
    const epoch = lifecycleEpoch;
    const activeHost = await getHost(epoch);
    assertActive(epoch);
    return operation(activeHost);
  };
  return {
    get running() {
      return host?.running ?? false;
    },
    get socketPath() {
      return host?.socketPath ?? null;
    },
    get pluginAuthority() {
      return host?.pluginAuthority ?? null;
    },
    async start() {
      return withActiveHost((activeHost) => activeHost.start());
    },
    async checkHealth(timeoutMs?: number) {
      return withActiveHost((activeHost) => activeHost.checkHealth(timeoutMs));
    },
    async waitForTransport(timeoutMs?: number) {
      return withActiveHost((activeHost) => {
        if (!activeHost.waitForTransport) {
          // 兼容旧注入 Host：没有两阶段接口时，完整 start handle 就是唯一可用 tuple。
          return activeHost.start().then((handle) => ({
            socketPath: handle.socketPath,
            pluginAuthority: handle.pluginAuthority,
          }));
        }
        return activeHost.waitForTransport(timeoutMs);
      });
    },
    async restart() {
      return withActiveHost((activeHost) => activeHost.restart());
    },
    async restartAfterCurrentStart() {
      return withActiveHost((activeHost) => activeHost.restartAfterCurrentStart());
    },
    async restartAfterCurrentStartPreservingTransport(
      restartOptions?: CuaHelperTransportRestartOptions,
    ): Promise<CuaHelperTransportRestartResult> {
      return withActiveHost((activeHost) => {
        if (activeHost.restartAfterCurrentStartPreservingTransport) {
          return activeHost.restartAfterCurrentStartPreservingTransport(restartOptions);
        }
        // 兼容旧注入 Host：wrapper 一旦暴露 preserving 接口，就必须代为提交 fresh-start
        // marker；否则 producer 会在新 tuple 已启动后判定 fail-closed 契约被破坏。
        restartOptions?.beforeFreshStart?.();
        return activeHost.restartAfterCurrentStart().then((handle) => ({ handle, reused: false }));
      });
    },
// [资源] stop 幂等：第二次调用直接复用同一条 draining promise，调用方 await 到的是同一次收尾。
// 顺序是「先等已在途的解析落定、再停 host」，反序会让解析在 host.stop 之后才建出新 host 并逃逸。
    async stop() {
      if (stopDrain) return stopDrain;
      stopped = true;
      lifecycleEpoch += 1;
      const pendingResolution = resolving;
      stopDrain = (async () => {
        // 等待已开始的解析落定，确保它观察到 terminal epoch；否则 dispose 之后仍可能晚到地启动 Helper。
        await pendingResolution?.catch(() => undefined);
        await host?.stop();
      })();
      return stopDrain;
    },
  };
}

// macOS 与 Windows 的 Helper 宿主形态不同：macOS 为「应用内置 Helper + 独立权限 host」，Windows 为
// 「安装包内 runtime + 命名管道」。共同点只有 resolver 契约，因此这里只返回统一形状，平台细节留在分支内。
export function createDefaultCuaProductHelper(
  options: CreateDefaultCuaProductHelperOptions,
): DefaultCuaProductHelper | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (!shouldEnableDefaultCuaProductHelper({ platform, env })) {
    return undefined;
  }
  const logger = createServiceLogger("cua-product-helper");
  // Best-effort, once per process: reap Helpers orphaned by prior sessions before minting a
  // fresh one. Complements the per-Helper launcher-pid watchdog (helperMain); the reaper never
  // throws, so it cannot block startup.
  if (platform === "darwin" && !orphanHelperReaperHasRun) {
    orphanHelperReaperHasRun = true;
    reapOrphanedHelpers({ logger, env });
  }
  let macPermissionHost: CuaHelperHost | undefined;
  let host: ManagedCuaProductHelperHost;
  if (platform === "darwin") {
    const bundledHelperAppPath = resolveBundledCuaHelperAppPath();
    if (!bundledHelperAppPath) {
      logger.error(
        undefined,
        "CUA product Helper is unavailable: packaged Resources path was not resolved",
      );
      return undefined;
    }
    macPermissionHost =
      options.createMacHost?.() ??
      createProductCuaHelperHost({
        logger,
        env: process.env,
        helperInstaller: createCanonicalCuaHelperInstaller({
          logger,
          env: process.env,
          bundledAppPath: bundledHelperAppPath,
        }),
        // 冲突解决原则：macOS 继续严格消费应用内置 Helper，不能退回下载源；
        // Windows 才走下方独立的安装包 runtime 解析链路。
        bundledHelperAppPath,
        // tolerate the Helper's cold first-launch instead of the 5s default.
        healthTimeoutMs: CUA_HELPER_HEALTH_TIMEOUT_MS,
        // producer product factory 统一固定 ghost cursor/PiP=true、background=false。
        // consumer 不再传伪动态 getter，避免两个仓库各保存一份产品策略。
      });
    host = macPermissionHost;
  } else {
    host = createWindowsCuaHelperHost({
      resolveRuntime:
        options.resolveWindowsRuntime ??
        (() =>
          resolveWindowsCuaRuntime({
            platform,
            env,
            resourcesPath: options.resourcesPath,
            arch: options.arch,
            electronVersion: options.electronVersion,
          })),
      createHost:
        options.createWindowsHost ??
        ((runtime) =>
          new WindowsCuaHelperHost({
            runtime,
            logger,
            mintSocketPath: () => getStableCuaPipeName(),
          })),
      logger,
    });
  }
  const resolver = createCuaProductMcpServerResolver(host, {
    hasActiveTurn: options.hasActiveTurn,
  });
  return {
    host,
    ...(macPermissionHost ? { macPermissionHost } : {}),
    resolver,
  };
}

export const ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV = "ZCODE_CUA_BUNDLED_HELPER_APP_PATH";

// 路径优先级：显式 env 注入 > 打包 Resources 目录。env 优先是为了让 E2E 与本地开发指向自建 Helper，
// 而生产必须走 Resources：允许回退到下载源会让「签名主体」与授权主体分叉，TCC 授权对不上。
export function resolveBundledCuaHelperAppPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const injectedPath = env[ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV]?.trim();
  if (injectedPath) {
    return injectedPath;
  }
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath?.trim();
  return resourcesPath ? join(resourcesPath, "cua-helper", HELPER_APP_NAME) : undefined;
}

export { isOfficialCuaPluginEnabledForWorkspace };

// 探测用户全局 CLI 配置里是否已经声明了 zcode-cua MCP server：若已存在，Host 不能再注入一套 broker
// 凭据去覆盖它，否则两处各自持有 socket/token，会出现「同一台机器两个 Helper 抢同一稳定管道」。
// 读取失败（文件不存在/非法 JSON）一律按「没有」处理，绝不因为探测失败阻断启动。
export function hasGlobalCliZCodeCuaServer(env: NodeJS.ProcessEnv = process.env): boolean {
  const home = env.HOME?.trim() || homedir();
  const configPath = join(home, ".zcode", "cli", "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (isRecord(parsed.features) && parsed.features.mcp === false) return false;
  if (!isRecord(parsed.mcp) || !isRecord(parsed.mcp.servers)) return false;
  return Object.entries(parsed.mcp.servers).some(([name, config]) =>
    isGlobalCliZCodeCuaServer(name, config),
  );
}

// 判定必须与 @zcode/shared 的 isZCodeCuaMcpCommand / isZCodeCuaMcpPackageArg 共用同一事实源：
// 漏判 git/本地路径形态的 zcode-cua 会导致全局 CLI 注入不带 broker 凭据，agent 就退回 Python/uvx
// 自己持有 macOS TCC，直接违反 product broker 边界。
function isGlobalCliZCodeCuaServer(name: string, config: unknown): boolean {
  if (!isRecord(config)) return false;
  if (config.enabled === false) return false;
  if (typeof config.type === "string" && config.type !== "stdio") return false;
  if (name === "computer-use") return true;
  // 与 desktop/services resolver 和 CLI bootstrap 共用 @zcode/shared 的单一事实源，避免第三处
  // 判定漂移：git/.git/本地路径形态的 zcode-cua 若这里漏判，全局 CLI env 注入不会带 broker
  // socket/token，agent 会回退成 Python/uvx 自己持有 macOS TCC（违反 product broker 边界）。
  if (typeof config.command === "string" && isZCodeCuaMcpCommand(config.command)) {
    return true;
  }
  return (
    Array.isArray(config.args) &&
    config.args.some((arg) => typeof arg === "string" && isZCodeCuaMcpPackageArg(arg))
  );
}

// 外部 JSON 的形状守卫：数组也是 object，必须显式排除，否则 ".some" 之类调用会在数组上静默走偏。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 创建包含所有本地服务的 ServiceCollection
 *
 * @param options.parentPort - Electron host process 的 parentPort，
 *        用于 BroadcastService 跨窗口中转。传 null 则广播为空操作。
 */
// createLocalServices 是唯一的 Host 装配入口：desktop-local、desktop-attached-remote、standalone-server
// 三种 authority 走同一份代码，靠 options.serviceAuthorityMode 与注入点分叉。新增能力时必须先想清楚
// 「这个 Host 在三种形态下分别由谁提供事实」，否则会把桌面事实带进远端（或反之）。
//
// [权衡] 参数全走一个 options 对象而不是位置参数：注入点已超过 20 个且多数可选，位置参数会让调用方
// 在新增参数时静默错位。代价是这个接口本身就是 Host 的依赖清单，改它等于改所有装配调用方。
export function createLocalServices(options: {
  /** 已鉴权 Desktop stdio 连接提供的私有回查频道；不作为公共 service 暴露。 */
  topicResourceRelayChannel?: (request: unknown) => IChannel;
  parentPort?: Parameters<typeof createBroadcastService>[0];
  /** Desktop Window Host 提供当前 Source 身份和线路，其他宿主不推断 Desktop 状态。 */
  resolveBotRemoteWorkspace?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
  }) => Promise<{ workspacePath: string; workspaceIdentity: string } | null>;
  /** Host 装配层注入的设置权威；与网络 transport 必须来自同一 Window Host 生命周期。 */
  settingService?: ISettingService;
  setWorkspaceProjection?: ReturnType<
    typeof createSettingServiceWithMigrations
  >["setWorkspaceProjection"];
  /** 与注入的本地 Setting 共用写队列；外部远端 Setting 不传，由其权威 Host 完成迁移。 */
  prepareLegacyAccountConnections?: ReturnType<
    typeof createSettingServiceWithMigrations
  >["prepareLegacyAccountConnections"];
  /** 注入后由 ServiceCollection 接管释放，并供 Host 其它 app-managed 下载复用。 */
  hostApiNetworkTransport?: HostApiNetworkTransport;
  /** Desktop Host 注入 Main 推送的实时界面语言，供 ZCode endpoint 的 X-Client-Language；远端 server 不注入。 */
  resolveClientLanguage?: () => string | undefined;
  /** Desktop Host 请求 Main 登记 Agent 已授权的精确本地视频路径。 */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  /**
   * 动态工作流用户选择变化后的转发口（docs/dynamic-workflow/launch.md「The user's choice」）：
   * Desktop Host 把本机设置里的选择推给本窗口所有在线的 desktop-attached remote Host。
   */
  forwardDynamicWorkflowUserMode?: (mode: DynamicWorkflowMode | undefined) => void;
  /** Desktop Host 请求 Main 登记已校验的插件 UI HTML，换取沙箱句柄。 */
  registerPluginSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  feedback?: Partial<
    Omit<CreateFeedbackServiceOptions, "apiClient" | "credentialService" | "oauthService">
  >;
  reportPluginTelemetryEvent?: (
    event: import("@zcode/shared").RendererTelemetryEventPayload,
  ) => void | Promise<void>;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  taskRuntimeReporter?: RuntimeTaskReporter;
  /** workspace 文件搜索默认使用内置过滤器；后续规则来源只需在 Host 装配时注入最终实现。 */
  workspaceFileSearchFilter?: WorkspaceFileSearchFilter;
  forwardSessionMessageSendRequested?: (
    request: SessionMessageSendRequested,
  ) => Promise<void> | void;
  /** desktop local host 在 manual run 落库后直接派发，不经过 scheduler 正常路径。 */
  onAutomationManualRunRequested?: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  /** 闲时任务翻 schedulable 后请求宿主立即唤醒 scheduler（desktop host 注入 parentPort 转发）。 */
  onOffPeakSchedulerWakeRequested?: () => void;
  // 注入点：默认 resolver 已能覆盖 dev/桌面/SSH 远端三类形态；
  // 测试或特殊宿主想强制走自定义 binary/参数时从这里注入。
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
  /** Desktop Main 提前异步采集的本机 runtime 环境；Local Host 注入后不再同步启动 login shell。 */
  runtimeProcessEnvPatch?: Record<string, string>;
  /** 本地桌面上次 workspace 缺失时，仅用于 Agent 子进程 spawn.cwd 兜底。 */
  zcodeAgentSpawnFallbackCwd?: string;
  /** desktop-attached remote server 从 Desktop Host 收到的一次性 Agent 网络配置。 */
  remoteAgentNetwork?: {
    httpProxy?: string;
    noProxy?: string;
  };
  /** 所属 Environment 的 ZCode Built-in Provider Config 物理路径。 */
  zcodeBuiltinProviderConfigFilePath: string;
  /** HTTP Server 只有在调用方明确配置认证时才暴露跨 Environment Provisioning target。 */
  providerProvisioningTargetEnabled?: boolean;
  /** Desktop Host 私有通知；只在 Source 成功持久化后请求 Main 调度远端镜像。 */
  onProviderProvisioningSourceChanged?: (
    trigger: Exclude<ProviderProvisioningTrigger, "environment-online">,
  ) => void;
  serviceAuthorityMode?: ServiceAuthorityMode;
  /** 可信 Server Core 注入，区分物理持库 Host 与历史 workspace canonical route。 */
  projectStorageHostId?: string;
  sourceServerWorkspaceService?: ISourceServerWorkspaceService;
  resolveProjectHostService?: (hostId: string) => Promise<IProjectService>;
  /** Bot 复用窗口已有 Source 连接；不经 main 创建 workspace attachment。 */
  resolveBotProjectConnection?: (hostId: string) => BotProjectConnection | undefined;
  remoteProjectConnection?: Pick<
    Parameters<typeof createRemoteProjectService>[0],
    "connectHost" | "readConnectionStates"
  >;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
  agentTelemetry?: {
    getDeviceMid?: () => string | undefined;
    runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  };
  /** browser-use 执行桥（host→main WebContentsView+CDP）；desktop host 注入，缺省则 browser 不可用。 */
  browserControlExecutor?: {
    list(input: {
      requestId: string;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
    }): Promise<BrowserBackendDescriptor[]>;
    execute(input: {
      requestId: string;
      browserId?: string;
      browserGeneration?: number;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
      command: BrowserCommand;
    }): Promise<{ ok: boolean; [k: string]: unknown }>;
  };
  /** Windows desktop-local Host 的 CUA turn 状态投影；其它 authority 会在装配层拒绝。 */
  cuaOperationStateReporter?: CuaOperationStateReporter;
// 下面的顺序即初始化顺序，不可随意调整：环境 → CA → 设置 → 凭据 → 账号事实 → provider runtime →
// Agent/Session → 项目/任务 → CUA → 注册链。反向依赖只能通过前向引用 holder 或惰性闭包表达，
// 因为域服务在构造期就会读取设置、凭据与 provider 快照（异步 start 也必须早于 Agent spawn）。
}): ServiceCollection {
  const isDesktopAttachedRemote = options?.serviceAuthorityMode === "desktop-attached-remote";
  // host / remote server 以前直接沿用当前进程环境启动后续服务。
  // GUI 启动的 desktop、SSH/WSL/Docker 拉起的 remote server 往往拿不到用户 login shell 里的 PATH，
  // 导致 bun 这类只在 shell profile 里追加的命令在 ZCode Agent/终端里不可见。
  // 这里在所有本地服务启动前统一修正运行时环境，并顺带把内置 rg 注入 PATH，
  // 让 ZCode Agent、终端、认证 runtime 共用同一套命令解析结果。
// [权衡] 这一步必须在任何服务构造之前：GUI 启动拿不到 login shell 的 PATH，后续所有子进程
// （Agent、终端、认证 runtime）都继承本进程 env，如果先建服务再修正，已缓存的命令解析结果就会分叉。
// patch 由 Desktop Main 提前异步采集，传入时跳过同步 login shell 启动，避免阻塞首屏。
  initializeRuntimeProcessEnv(options?.runtimeProcessEnvPatch);

// 三态而不是布尔：显式 "1"/"0" 表示宿主强制开关，其余值返回 undefined 让下游走平台默认。
// 把未设置当成 false 会让所有旧用户悄悄失去 desktop context prompt。
  const desktopContextPromptEnabledRaw =
    process.env[ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]?.trim();
  const desktopContextPromptEnabled =
    desktopContextPromptEnabledRaw === "1"
      ? true
      : desktopContextPromptEnabledRaw === "0"
        ? false
        : undefined;

  // app 自签 CA：首次启动生成一份根 CA（幂等），供 agent 子进程经 NODE_EXTRA_CA_CERTS 信任、
  // 出口代理用其私钥重签。生成失败不应阻断启动（例如只读文件系统），仅记录日志后继续。
  try {
// [失败路径] 自签 CA 生成失败只记日志、不阻断启动：只读文件系统或权限受限时仍要能打开 Host，
// 代价是该次运行的 HTTPS 出口代理不可用（fail-open 到直连），而非整个 app 起不来。
    ensureAppCaCert();
  } catch (error) {
    console.error(formatLogPrefix("appCaCert", process.pid), "ensure app CA cert failed:", error);
  }

// [事务] 设置只有一位所有者：注入时（Host 装配层提供权威实例）本文件不再建本地库，也不做迁移；
// 未注入时由本进程建库并承担迁移。两处同时迁移会把同一份旧文件升级两次，第二次读到的是半迁移态。
  const localSettings = options?.settingService ? null : createSettingServiceWithMigrations();
  const settingService = createObservableSettingService(
    options?.settingService ?? localSettings!.service,
  );
// endpoint origin 的单一解析口：env 提供默认值，设置里的 origin 覆盖它。
// 所有出站链路（API、官方 MCP、闲时任务、内置配置刷新）都必须走这里，否则覆盖只在部分链路生效。
  const resolveCurrentZCodeEndpointOrigin = async () =>
    resolveRuntimeZCodeEndpointOrigin(process.env, {
      overrideOrigin: (await settingService.get()).zcodeEndpointOrigin,
    });
// 前向引用占位：credentialService 的变更回调可能早于 projectTokenClient 构造，
// 此时失效动作必须是 no-op 而不是抛错（那一轮还没有缓存可清）。
  let invalidateProjectTokens = () => {};
  let invalidatePluginUiAccounts: (() => void) | undefined;
// 凭据变更的失效扇出：oauth 身份类 key 影响插件 UI 账号视图，provisioning 类 key 影响项目 token 与
// provisioning source。两类必须分开判定——把前者也当成 provisioning 会让每次刷新都重算 token，
// 而漏掉后者会让 Agent 继续用已轮换的旧密钥直到进程重启。
  const provisioningOAuthKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
// credentialService 是进程内唯一凭据读写口；onDidMutate 里的回调必须保持同步且轻量（只做失效标记与
// 通知），不能在变更回调里 await 网络，否则会拖住所有后续凭据写入并造成登录态更新排队。
  const credentialService = createCredentialService({
    onDidMutate: ({ key }) => {
      if (key === "oauth:active_provider" || /^oauth:[^:]+:user_info$/.test(key))
        invalidatePluginUiAccounts?.();
      if (provisioningOAuthKeys.has(key)) invalidateProjectTokens();
      if (provisioningOAuthKeys.has(key)) {
        options.onProviderProvisioningSourceChanged?.("credential");
      }
    },
  });
// 账号凭据存储与 credentialService 共用键空间：所有 oauth:* 键都经它读写，
// 这样凭据变更回调里的失效广播才能覆盖到同一批键。
  const accountProviderCredentialStore = createAccountProviderCredentialStore({
    credentialService,
  });
// 广播是唯一的跨窗口事件口：parentPort 为 null（非 Electron host）时退化为空操作，
// 调用方不需要判空——这是刻意保留的 no-op 语义，避免每个发送点都写 if。
  const broadcastService = createBroadcastService(options?.parentPort ?? null);
// checkpoint 索引落在独立目录（getGitCheckpointIndexRootDir），与用户仓库隔离：
// 把检查点写进用户 .git 会污染工作区状态，也会被用户的 cleaner 误删。
  const gitCheckpointService = createGitCheckpointService();
// 代理/自定义 CA 在每次请求时实时读设置，而不是构造时快照：用户改完代理应立刻生效，
// 代价是每次请求多一次 settings.get（有内存缓存，可接受）。注入的 transport 由注入方负责释放。
  const hostApiNetworkTransport =
    options?.hostApiNetworkTransport ??
    createHostApiNetworkTransport(async () => {
      const settings = await settingService.get();
      return {
        httpProxy: settings.httpProxy,
        noProxy: settings.httpProxyNoProxy,
        caCertPath: settings.httpProxyCaCertPath,
      };
    });
// 用 ref 打破 apiClient ↔ oauthService 的循环依赖：apiClient 只需要「拿到当前 handler」，
// handler 在 oauthService 建好后写入。启动窗口内的 401 没有业务请求可达，因此不会漏处理。
  const zcodeJwtLogoutHandlerRef: {
    current: ((input: string | URL, headers: Headers) => void) | null;
  } = { current: null };
// [事务] ZCode JWT 失效回调用 ref 间接调用：logout handler 依赖 oauthService，而 oauthService 又要
// 用 apiClient，直接闭包会形成构造期循环。ref 在 oauthService 建好后立即赋值，此前的 401 只会被忽略
// （启动窗口内没有业务请求），不会把已失效凭据留在内存。
// 端点 origin 通过 resolveCurrentZCodeEndpointOrigin 统一解析，保证 API、代理、MCP 信任判定同口径。
  const apiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
    onZcodeJwtInvalid: (input, headers) => zcodeJwtLogoutHandlerRef.current?.(input, headers),
    isZcodeJwtRequest: (input, headers) =>
      isCurrentOAuthCredentialRequest({ input, headers, credentialService }),
    isBusinessUnauthorizedRequest: (input, _headers) =>
      isOAuthBusinessRequest({ input, credentialService }),
    resolveBusinessCredentialValidationRequest: (input, headers) =>
      resolveOAuthBusinessCredentialValidationRequest({ input, headers, credentialService }),
    resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
    resolveClientLanguage: options?.resolveClientLanguage,
  });
// 系统服务是同步构造的纯本机能力包装（homedir、平台信息），无 IO 也无生命周期，
// 因此可以在装配早期拿到，供后面的 projectService.directories.home 使用。
  const systemService = createSystemService();
  // onboarding 资格与任务列表共用同一份全局 tasks-index；repo 懒加载数据库，提前构造不会
  // 增加启动 I/O，后续 session syncer 也继续复用这一实例。
  const taskIndexRepo = new TaskIndexRepo(undefined, options?.projectStorageHostId);
// [并发] tasks-index 是「每个 Host 一份」的物理库，hostId 决定它落在哪个目录。这个实例是全进程唯一
// 写入者：project/task/automation/syncer 全部经它拿连接，任何地方再 new 一个都会产生第二条写路径。
  // onboarding 完成记录：userId 由登录态补全（apikey/未登录为 null），见 docs/onboarding-record-spec.md。
// onboarding 证据判定每次登录至多执行一次，日志量可控；两条 debug 分别记录「跳过原因」与「查询结果」，
// 便于线上复核到底走了哪个证据源（不记录完整路径，避免 home 路径进日志）。
  const onboardingEvidenceLogger = createServiceLogger("onboardingRecordService");
// 老用户判定是「是否弹引导」的唯一依据，因此三条证据源的优先级被刻意写死：索引（可能滞后）→
// 会话库磁盘事实 → 旧版快照目录。任一命中即算老用户，宁可漏弹也不误弹（2026-10 线上事故）。
  const onboardingRecordService = createOnboardingRecordService({
    loadUserId: async () => (await oauthCredentialRepo.loadActiveUserProfile())?.id ?? null,
    // 老用户使用证据不能只查 tasks-index：索引是 session 同步器的衍生投影，同步器在
    // agent/provider 就绪后才回填，而判定在登录完成、主界面挂载时执行，早于回填——
    // 2026-10 线上误弹：索引重建后登录瞬间判定看到空索引，老用户被当成新用户弹出引导
    // （取证：判定时刻全部历史任务行还在 WAL 未落库）。会话库与旧版快照目录是磁盘级
    // 持久事实，与同步时序无关；includeDeleted 让清空过任务列表的存量用户也不失去
    // 资格。会话证据必须查 cli/db/db.sqlite 的 session 表（评审 CR-01：cli/sessions
    // 是工作流输出目录，且文件存在性不代表有会话）。
    hasExistingLocalTask: createHasExistingLocalTask({
      listIndexTasks: () => taskIndexRepo.listTaskMetas({ includeDeleted: true }),
      // 解析结果 null（相对路径/project 覆盖等无法镜像的配置）→ 跳过会话证据源，
      // 继续旧版快照检查；不得猜默认路径，否则自定义会话库的存量用户被漏判。
      // 跳过/命中各留一条 debug（评审 SG-02）：判定每登录一次至多一条，线上复核
      // "走了哪个证据源"有据可依；不记录完整路径，避免 home 路径进日志。
      hasAgentSessionRow: async () => {
        const sessionDbPath = await resolveAgentSessionDbPath();
        if (sessionDbPath === null) {
          onboardingEvidenceLogger.debug(
            "onboarding 会话证据源跳过：会话库路径不可镜像（相对路径或 project 级覆盖）",
          );
          return false;
        }
        const hasRow = await hasAnyAgentSessionRow(sessionDbPath);
        onboardingEvidenceLogger.debug("onboarding 会话证据源已查询", { hasRow });
        return hasRow;
      },
      resolveLegacyTaskSessionsDir: () => join(resolveAppConfigDir(), "sessions"),
    }),
  });
// 可空引用：损坏凭据清理回调在 handler 之前构造，只能通过这里晚绑定；
// 若改成可选依赖注入，会把「凭据损坏」这一失败路径的清理静默变成不清理。
  let handleOAuthProviderLogout: ReturnType<typeof createOAuthProviderLogoutHandler> | null = null;
// [失败路径] 损坏 OAuth 凭据的清理必须等价于 logout：删除凭据后还要清派生模型 key，并交给原 Account
// Source 队列刷新。这里用 void + catch 而非 await，是因为清理发生在读取路径上，等待刷新会让当前读取
// 循环等待自身（刷新又要读同一份凭据）。失败只 warn，后台可观察。
  const oauthCredentialRepo = new OAuthCredentialRepo(credentialService, {
    onCorruptOAuthSessionCleared: async (providers) => {
      // telemetry 之外的后台路径可能先读到损坏 OAuth 凭据。
      // 这类恢复也必须等价于 logout，复用同一 handler 清理派生模型 provider key。
      // 账号刷新 resolver 也可能读到损坏 token；等待下一轮刷新会让当前轮循环等待自身。
      // OAuth 删除已经完成，派生刷新交回原 Account Source 队列，后台只观察失败。
      void Promise.all(
        providers.map((provider) => handleOAuthProviderLogout?.(provider) ?? Promise.resolve()),
      ).catch((error: unknown) => {
        createServiceLogger("oauth-credential-recovery").warn(
          "refresh derived providers after corrupt OAuth cleanup failed",
          { error },
        );
      });
    },
  });
// [并发] 项目 token 客户端有内存缓存，凭据变更时必须 clear（见上方 invalidateProjectTokens），
// 否则换号后仍用旧账号的项目令牌访问，表现为 403 或读到别人的项目元数据。
  const projectTokenClient = createAccountProjectTokenClient(apiClient, credentialService);
  invalidateProjectTokens = () => projectTokenClient.clear();
// 远端 ApiKey 客户端与 projectTokenClient 分工：前者向账号服务换取材料，后者管理项目令牌，
// 两者都在解析器内部按 rejected fingerprint 决定是否需要重取。
  const accountProviderApiKeyRemoteClient = new AccountProviderApiClient(apiClient);
// ApiKey 解析器把「远端材料」与「项目 token」两路合并：rejectedProjectTokenFingerprint 用来在
// 项目令牌被拒后避免重复取同一枚，减少一次必然失败的请求。
  const accountProviderApiKeyResolver = new AccountProviderApiKeyResolver(
    accountProviderApiKeyRemoteClient.fetchRemoteData.bind(accountProviderApiKeyRemoteClient),
    projectTokenClient,
  );
// family ↔ providerId 的映射在这几处重复出现（zai → ZAI_PROVIDER_ID，其余 → BIGMODEL_PROVIDER_ID）：
// 这是账号域仅有的两家 Coding Plan。写法保持一致是为了让新增 family 时能一次性搜全改动点；
// 映射错了会让 A 家的 token 去换 B 家的 material，网关侧表现为 401 或额度串号。
  const accountProviderCredentialService = createAccountProviderCredentialService({
    async loadOAuthAccessToken(family) {
      const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
      return (await oauthCredentialRepo.loadTokenSet(oauthProviderId))?.accessToken ?? null;
    },
    resolveProviderMaterial: (
      family,
      accessToken,
      accountIdentity,
      rejectedProjectTokenFingerprint,
    ) =>
      accountProviderApiKeyResolver.resolveProviderMaterial(
        family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID,
        accessToken,
        accountIdentity,
        rejectedProjectTokenFingerprint,
      ),
  });
// 旧团队组织解析只用于设置迁移：把历史上写在设置里的组织信息补成账号连接，
// 它随迁移一起执行一次，不参与常规请求路径。
  const resolveLegacyTeamOrganization = createLegacyTeamOrganizationResolver({
// 迁移协调者只在这一处被传入：账号事实入口负责触发一次性迁移，其它读者只读迁移后的设置。
    apiClient,
    loadOAuthTokenSet: (family) =>
      oauthCredentialRepo.loadTokenSet(family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID),
  });
  const readAccountProviderSettings = async () => {
// [事务] 迁移只在这个「账号事实入口」协调，ApiClient 的代理/端点仍读普通 Setting 以免递归等待。
// 注入的 Setting（远端 attachment）由其所属 Host 负责迁移，本机不读旧文件，避免跨 Host 双写。
    // 迁移只在账号事实入口协调。ApiClient 的代理/端点仍读普通 Setting，不递归等待迁移。
    // 外部注入的 Setting（远端 attachment）由其所属 Host 管理，不读取本机旧文件。
    const prepare =
      options?.prepareLegacyAccountConnections ?? localSettings?.prepareLegacyAccountConnections;
    const unresolvedFamilies = (await prepare?.(resolveLegacyTeamOrganization)) ?? [];
    const settings = await settingService.get();
    return {
      providerFamilyDomain: settings.providerFamilyDomain ?? null,
      selections: settings.providerFamilyConnectionSelections ?? {},
      unresolvedFamilies,
    };
  };
// 账号身份（user id）是套餐材料与额度归属的键：取不到时上层一律返回 null 而不是匿名降级，
// 因为匿名请求会落到别的账号额度上。
  const loadAccountIdentity = async (family: ProviderFamilyDomain) => {
    const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
    return (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id ?? null;
  };
// 账号请求鉴权是「一次请求该带什么身份」的唯一裁决点：个人套餐、团队套餐与项目 token 三条路径
// 都在这里汇合。外部（Agent、闲时任务、官方 MCP、用量统计）必须共用它，各自拼头会造成额度与身份错配。
  const accountRequestAuthService = createAccountRequestAuthService(
    createAccountProviderRequestAuthService({
      resolveCurrentAccountAccess: (access) =>
        resolveCurrentAccountAccess({
          access,
          readSettings: readAccountProviderSettings,
          loadAccountIdentity,
        }),
      loadOAuthTokenSet: (providerId) => oauthCredentialRepo.loadTokenSet(providerId),
      async loadIndividualPlanMaterial(providerId, family, rejectedProjectTokenFingerprint) {
        const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
        const accountIdentity = (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id;
        if (!accountIdentity) return null;
        return accountProviderCredentialService.loadCodingPlanMaterial({
          providerId,
          family,
          accountIdentity,
          rejectedProjectTokenFingerprint,
        });
      },
      resolveTeamPlanMaterial: async (access, rejectedProjectTokenFingerprint) => {
        const accountIdentity = await loadAccountIdentity(access.family);
        if (!accountIdentity) return null;
        return resolveAccountTeamPlanRuntimeMaterial({
          apiClient,
          credentialService,
          access,
          accountIdentity,
          tokenClient: projectTokenClient,
          rejectedProjectTokenFingerprint,
        });
      },
    }),
  );
// Provider 配置的日志分级刻意区分：只有真正的 updated 走 info（生产可观察），
// 其余刷新检查走 debug——轮询频率高，用 info 会让日志随在线时长线性增长。
  const providerConfigLog = createServiceLogger("provider-config");
// 平台标识同时用于内置配置的 CDN 选择与请求头，必须只解析一次：两处各算一次会在
// 交叉编译/模拟运行环境里给出不同的值（例如 arch 被 env 覆盖）。
  const clientConfigPlatform = resolveClientConfigPlatform();
// Provider 配置分三层：内置配置（随版本/CDN 更新）、个人配置（用户手动改的文件）、账号派生的连接
// 事实。三者由 configRuntime 统一合并成一份可订阅视图，禁止任何调用方绕过它自己读文件——否则
// 「内置已更新、个人文件未更新」的中间态会在不同读者眼里给出不同的 provider 列表。
// [事务] 远端刷新失败只降级不写盘：保留磁盘既有配置，内存侧走空配置，避免把网络故障固化成配置损坏。
  const providerConfigRuntime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: options.zcodeBuiltinProviderConfigFilePath,
    zcodeBuiltinEnvironment: {
      environmentConfigRoot: resolveAppConfigDir(),
      platform: clientConfigPlatform,
      appVersion: ZCODE_VERSION,
      resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
      onRefreshResult: (event) => {
        if (event.result === "updated")
          providerConfigLog.info(undefined, "ZCode Built-in CDN 配置已更新", event);
        else providerConfigLog.debug(undefined, "ZCode Built-in 刷新检查", event);
      },
      fetchRelease: (endpointOrigin, signal) =>
        fetchZCodeBuiltinRemoteRelease({
          apiClient,
          endpointOrigin,
          signal,
          appVersion: ZCODE_VERSION,
          platform: clientConfigPlatform,
        }),
    },
    onZCodeBuiltinRefreshError: (error) => {
      providerConfigLog.warn(undefined, "ZCode Built-in Config 远端刷新失败", { error });
    },
    onPersonalConfigRecovery: (event) => {
      providerConfigLog.warn(
        undefined,
        "Personal Provider Config 加载失败，已保留磁盘状态并以内存空配置降级",
        {
          error: event.error,
        },
      );
    },
// 轮询错误只在「进入失败状态」时回调一次，后续失败不重复上报：持续故障时刷盘日志会掩盖真正的
// 首次原因，也会让日志量随故障时长线性增长。
    onPersonalConfigPollingError: (error) => {
      // 轮询错误只在进入失败状态时回调一次；下一轮仍会自行重试，避免持续故障刷盘。
      providerConfigLog.warn(undefined, "Personal Provider Config 轮询暂时失败，将继续重试", {
        error,
      });
    },
    // 已发布 config.json 保存的是 ZCode 用户配置；清理第三方 ACP 不能移除这条升级路径。
    // Repository 仅在新 Personal 配置不存在时导入，并保留旧文件以便回滚。
    readLegacyProviders: () => readLegacyZCodeConfigProviders(),
  });
// 账号派生连接把「账号事实」翻译成 provider 连接：它只消费 configService 与账号鉴权，不直接读凭据
// 文件。Start Plan 这类内置额度 provider 返回 null 是刻意跳过，不能顺手补一个默认 key。
  const accountProviderConfigSource = createAccountProviderConfigSource({
    configSource: providerConfigRuntime.configService,
    readSettings: readAccountProviderSettings,
    async loadCodingPlanApiKey(providerId, family, accountIdentity, forceRefresh) {
      if (isStartPlanModelProviderId(providerId)) return null;
      return accountProviderCredentialService.loadCodingPlanApiKey({
        providerId,
        family,
        accountIdentity,
        forceRefresh,
      });
    },
    loadAccountIdentity,
    resolveFamilyAvailability: createCodingPlanFamilyAvailabilityResolver({
      apiClient,
      credentialService,
    }),
  });
// 账号 provider 刷新失败只 warn 且带 reasons：失败通常是账号侧瞬时问题，
// 下一次设置变更或轮询会自愈，因此不升级为 error 也不阻断请求。
  const accountProviderRuntimeLog = createServiceLogger("account-provider-runtime");
// 默认模型选择的持久化落在个人 provider 配置仓库里，与 provider 配置共用同一份文件锁；
// [资源] 它自己有 dispose，必须挂在 disposeModelSelectionConfiguredDefaultSource 上随 runtime 释放。
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: providerConfigRuntime.personalRepository,
  });
// Provisioning Source 是「本 Environment 能给别的 Environment 提供什么凭据」的唯一事实源，
// 与 personalRepository / settingService / 凭据文件同一份存储。它不进 RPC，只由 Host 私有取用。
  const providerProvisioningSource = createProviderProvisioningSource({
    personalRepository: providerConfigRuntime.personalRepository,
    settingService,
    credentialFilePath: resolveCredentialFilePath(resolveAppConfigDir()),
    personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
  });
// [并发] 每个 Window Host 都在轮询同一个个人配置文件，所以只把本进程「成功提交」的 updated 当作
// 同步触发；若把其它 Host 的 poll-changed 也算进来，一次保存会被重复计入多个代际，远端镜像反复重建。
  const providerProvisioningDisposers = [
    providerConfigRuntime.configService.onDidChange((reason) => {
      // 每个 Window Host 都会轮询同一文件；只把本进程成功提交的 updated
      // 作为同步触发，避免其它 Host 的 poll-changed 把一次保存重复计入多个代际。
      if (reason === "personal:updated") {
        options.onProviderProvisioningSourceChanged?.("personal-config");
      }
    }),
    settingService.onDidUpdate((event) => {
      if (
        event.keys.includes("providerFamilyDomain") ||
        event.keys.includes("providerFamilyConnectionSelections")
      ) {
        options.onProviderProvisioningSourceChanged?.("account-settings");
      }
    }),
  ];
// 设置变更 → 账号连接刷新的绑定：只在相关键变化时刷新，避免任意设置写入都触发一次远端材料重取。
  const disposeAccountProviderInvalidation = bindAccountProviderInvalidation({
    onDidUpdateSetting: (listener) => settingService.onDidUpdate(listener),
    refresh: (reason) => accountProviderConfigSource.refresh(reason),
  });
  const accountProviderRefreshErrorDispose = accountProviderConfigSource.onDidRefreshError(
    (event) => {
      accountProviderRuntimeLog.warn(undefined, "account provider source refresh failed", {
        error: event.error,
        reasons: event.reasons,
      });
    },
  );
// 连通性测试必须由 Agent 进程执行（要真正拉起 provider 调用），但 Agent 服务构造又依赖
// providerRuntime，因此用前向引用：测试请求只会在装配完成后到达。
// 引用为空时显式抛错，而不是返回「测试通过」的假结果。
  let providerConnectivityAgentService:
    | Pick<IZCodeAgentService, "testModelConnectivity">
    | undefined;
// providerRuntime 是「懒启动」的：构造只装配依赖，真正建 Registry 在 start()。这样 Host 启动不必等
// 网络与配置就绪，但任何需要 provider 事实的调用（Agent spawn、闲时任务、连通性测试）必须先 await start。
// [资源] disposeAccountSource 的回调顺序固定为「解绑失效监听 → 退订刷新错误 → dispose source」，
// 反序会让已释放的 source 继续收到设置变更通知。
  const providerRuntime = createProviderRuntimeFromConfigRuntime({
    configRuntime: providerConfigRuntime,
    accountSource: accountProviderConfigSource,
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
    testConnectivity: createProviderSettingsConnectivityTester({
      testModelConnectivity: async (input) => {
        if (!providerConnectivityAgentService) {
          throw new Error("Agent Service 尚未完成模型连通性测试装配");
        }
        return providerConnectivityAgentService.testModelConnectivity(input);
      },
    }),
    disposeAccountSource: () => {
      disposeAccountProviderInvalidation();
      accountProviderRefreshErrorDispose();
      accountProviderConfigSource.dispose();
    },
  });
// logout handler 在这里才赋值：它依赖已建好的 credential store 与 account source，
// 而损坏凭据清理回调（更早构造）通过可空引用调用它，形成无环的先后关系。
  handleOAuthProviderLogout = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore,
    refreshAccountProviders: (reason: string) => accountProviderConfigSource.refresh(reason),
  });
// 注入的 workspace 身份服务优先：standalone-server 需要把自己构造的 mapper 传进来，
// 本文件不重复创建（两个 mapper 会让同一路径得到两个身份）。
  const sourceServerWorkspaceService =
    options.sourceServerWorkspaceService ?? createSourceServerWorkspaceService();
  // 官方 Server MCP 的凭证解析源。MCP 调用的身份头与 MCP 额度查询（/api/v1/mcp/usage）
  // 必须共用这一份实现，否则两处对"当前选中的 Coding Plan 连接"的判定会分叉。
  // 额度侧注入的是凭证解析而非 resolveHeaders：归属校验需要 providerFamily，
  // 而身份头里没有 family；身份头仍由同一个 buildOfficialMcpAuthHeaders 构造。
// 官方 Server MCP 的身份头与额度查询（/api/v1/mcp/usage）必须共用这一份凭证解析，否则两处对
// 「当前选中的 Coding Plan 连接」判定会分叉：头里没有 providerFamily，额度侧只能靠解析结果补 family。
  const officialMcpCredentialSource = {
    resolve: () =>
      resolveOfficialMcpCredentials({
        accountRequestAuthService,
        credentialService,
        modelSelectionService: providerRuntime.modelSelection,
      }),
  };
  // mcpSync/hooks 里引用 zcodeAgentService 的闭包是惰性调用，声明顺序不影响初始化。
// mcpSync / hooks / pluginUi 里引用 zcodeAgentService 的闭包都是惰性调用，因此可以先声明后构造
// Agent 服务；但一旦有人在工厂求值期直接访问 zcodeAgentService，就会命中 TDZ 而非静默 undefined。
  const skillsService = createSkillsService({ isDesktopRuntime: true });
// mcp/list 的 host 消费点收拢到 mcpSync：host 只转发，真实状态检查仍在 agent 进程内完成，
// 避免 host 自己维护一份可能过期的 MCP server 状态。
  const mcpSyncService = createMcpSyncService({
    // mcp/list 的 host 消费点收拢到 mcpSync 服务；真实状态检查仍在 agent 进程。
    listMcpServerStatuses: (params) => zcodeAgentService.listMcpServerStatuses(params),
  });
// plugin-sync 必须注册：RemoteServiceAccess 会请求该频道，漏注册会让本地候选枚举超时、
// 远端同步根本不会开始（表现为插件页一直空列表）。
  const pluginSyncService = createPluginSyncService();
// 插件 UI 实例账号绑定负责「谁有资格开这个 UI」：读账号用 oauthCredentialRepo，开关实例交给 Agent
// 进程执行。invalidate 由凭据变更触发，保持与 credential 单一事实源同步。
  const pluginUiAccounts = createPluginUiAccountBindings({
    async readAccount() {
      const provider = await oauthCredentialRepo.loadActiveProvider();
      const profile = provider ? await oauthCredentialRepo.loadUserProfile(provider) : null;
      return [provider, profile?.id ?? null];
    },
    open: (params) => zcodeAgentService.openMcpUiInstance(params),
    close: (params) => zcodeAgentService.closeMcpUiInstance(params),
  });
// 账号变更后必须让插件 UI 的账号绑定失效：否则已打开的插件面板会继续显示上一个账号的身份。
  invalidatePluginUiAccounts = () => pluginUiAccounts.invalidate();
  const pluginUiBridgeService = createPluginUiBridgeService({
    reportTelemetryEvent: options?.reportPluginTelemetryEvent,
    openInstance: (params) => pluginUiAccounts.open(params),
    closeInstance: (params) => pluginUiAccounts.close(params),
    validateInstance: (params) => zcodeAgentService.validateMcpUiInstance(params),
    recycleInstance: (params) => zcodeAgentService.recycleMcpUiInstance(params),
    // 插件 UI：资源读取与 UI 工具调用都发生在 session 所在的 agent 进程；host 只做校验与登记。
    readMcpResource: (params) => zcodeAgentService.readMcpResource(params),
    callMcpToolForUi: (params) => zcodeAgentService.callMcpToolForUi(params),
    cancelMcpToolCallForUi: (params) => zcodeAgentService.cancelMcpToolCallForUi(params),
    readMcpResourceForUi: (params) => zcodeAgentService.readMcpResourceForUi(params),
    listMcpResourcesForUi: (params) => zcodeAgentService.listMcpResourcesForUi(params),
    listMcpResourceTemplatesForUi: (params) =>
      zcodeAgentService.listMcpResourceTemplatesForUi(params),
    subscribeMcpResourceForUi: (params) => zcodeAgentService.subscribeMcpResourceForUi(params),
    unsubscribeMcpResourceForUi: (params) => zcodeAgentService.unsubscribeMcpResourceForUi(params),
    listPluginUiSurfaces: (params) => zcodeAgentService.listPluginUiSurfaces(params),
    registerSandbox: options?.registerPluginSandbox,
  });
  // App-Provided Tools：页面工具登记与模型调用的认领 / 回传都发生在 session 所在的 agent 进程。
// App-Provided Tools 与 sampling 都由 session 所在的 agent 进程执行，host 只做转发与登记：
// 这样插件 UI 的工具调用与模型采样不会绕过会话的运行上下文。
  const pluginUiSamplingService = createPluginUiSamplingService({
    sample: (params) => zcodeAgentService.sampleMcpApp(params),
    cancelSampling: (params) => zcodeAgentService.cancelMcpAppSampling(params),
  });
  const pluginUiAppToolsService = createPluginUiAppToolsService({
    registerAppToolsForUi: (params) => zcodeAgentService.registerAppToolsForUi(params),
    unregisterAppToolsForUi: (params) => zcodeAgentService.unregisterAppToolsForUi(params),
    claimAppToolCallForUi: (params) => zcodeAgentService.claimAppToolCallForUi(params),
    resolveAppToolCallForUi: (params) => zcodeAgentService.resolveAppToolCallForUi(params),
  });
// subagents / commands / memory / output-style 都是纯配置投影服务，构造无 IO；但子 Agent 的运行时
// 快照必须在 Agent spawn 前准备（见 resolveSpawnEnv 中的 prepareRuntimeState），否则读到上一代配置。
  const subagentsService = createSubagentsService({
    isDesktopRuntime: true,
  });
// commands / subagents / skills 都以 isDesktopRuntime 标记运行环境：它们据此选择目录约定，
// 不能靠 process.platform 推断（同一平台也可能是 remote Host）。
  const commandsService = createCommandsService({ isDesktopRuntime: true });
// Hooks 的信任授予必须走 agent 服务：信任状态属于会话运行期，host 侧只保留入口，
// 自己存一份会让「用户已信任」与 Agent 实际执行判定不一致。
  const hooksService = createHooksService({
    grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
  });
  const memoryService = createMemoryService();
  // 只要当前进程已经装配 Provider Runtime，就由该 Environment 自己的 Selection View
  // 决定执行就绪状态。Desktop-attached remote 也读取远端自己的 Config/Account Facts。
  const modelSelectionReadinessSource = providerRuntime.modelSelection;
// 只要本进程装配了 Provider Runtime，执行就绪状态就由本 Environment 自己的 Selection View 决定；
// desktop-attached remote 同样读远端自己的 Config/Account Facts，不能借桌面结论。
  const agentAccountProviderConfigSource = accountProviderConfigSource;
  // ===== Computer Use Helper lifecycle 层（port 自 feat）=====
  // 约束：lifecycle coordinator 懒获取 + 代际 fence（dispose 仅来自显式 workspace 生命周期）；
  // 不创建定时健康探测；Helper restart 尽可能复用 host transport，既有 Agent 的 session、
  // 进程与 MCP stream 保持不变。
  // P1-a mitigation：createDefaultCuaProductHelper() 在 zcodeAgentService 存在之前就要组装 resolver，
  // 但"是否有活跃 turn"这个信号只有 zcodeAgentService 建好之后才能查询。用前向引用占位——resolver 真正
  // 调用 hasActiveTurn() 发生在后续某次 resolveMcpServers（异步），那时 hasActiveTurnRef 早已被赋值。
  // 先用前向引用连接 agent service 的 CUA turn tracker，避免在活跃 CUA 请求中途重启 Helper；
  // service 创建完成后再赋值。Helper recovery 始终不能回收 Agent。
// [权衡] 前向引用而不是把 helper 创建推迟到 Agent 服务之后：resolver 必须在 Agent 服务构造前注入。
// 安全性来自时序——resolver 真正调用 hasActiveTurn 发生在后续异步 resolveMcpServers 时，那时引用已赋值。
  let hasActiveTurnRef: (() => boolean) | undefined;
// 双门控：dev/internal 特性开关（ZCODE_CUA_DEV_MODE / ZCODE_CUA_PRODUCT_HELPER）直接放行，
// 生产路径回落到官方插件的 workspace enablement 判定。保留 dev 分支是为了本地自测不需要改 config.json，
// 但两条路径必须都收敛到「这个 workspace 到底要不要 CUA」这同一个问题。
  const isCuaEnabledForContext = (context?: CuaProductMcpServerResolverContext): boolean =>
    // 保留 main 原有 gate 行为（避免回归）：dev/internal 特性开启时（ZCODE_CUA_DEV_MODE=1 或
    // ZCODE_CUA_PRODUCT_HELPER=1）即视为启用，不依赖 config.json 显式 enable——main 的 bootstrap
    // 用 isZCodeCuaInternalFeatureEnabled 门控 bundled plugin，与 feat 的 workspace enablement 不同。
    // 生产路径（dev mode off）回落到官方插件 workspace enablement 判定（与 feat 一致）。
    isZCodeCuaInternalFeatureEnabled(process.env) ||
    isOfficialCuaPluginEnabledForWorkspace({
      env: process.env,
      workingDirectory: context?.workspacePath,
    });
// lifecycle manager 承担「懒获取 + 代际 fence」两件事：acquire 只建一次，dispose 只来自显式 Host 生命周期；
// 刻意不创建定时健康探测——Helper 不是 Agent runtime 的 owner，没有 CUA 需求时不该自愈或常驻。
  const defaultCuaProductHelperLifecycle =
    new CuaHelperLifecycleManager<ManagedDefaultCuaProductHelper>(async (managed) => {
      await managed.helper.host.stop();
    });
// [权衡] 这里不挂 10s 周期 watchdog：空闲期一次 broker_info 超时就会触发后台 restart，
// 而 Helper 不是 Agent runtime owner、没有 CUA 需求时也无自愈价值。健康检查留在 spawn env 与
// resolver 请求边界，避免后台 timer 干扰其它模块的时序。
  const createManagedDefaultCuaProductHelper = (
    context?: CuaProductMcpServerResolverContext,
  ): ManagedDefaultCuaProductHelper | undefined => {
    const helper = createDefaultCuaProductHelper({
      // 转发活跃-turn 查询（前向引用，zcodeAgentService 建好后赋值）。
      hasActiveTurn: () => hasActiveTurnRef?.() ?? false,
    });
    if (!helper) return undefined;

    // 历史默认装配启动 10 秒周期 watchdog；空闲期一次 broker_info 超时就会在后台
    // 调用 resolver.restart()。Helper 不是 Agent runtime owner，且无需在没有 CUA 需求时自愈；
    // 健康检查保留在 spawn env / resolver request boundary，避免后台 timer 干扰其他模块。
    return {
      helper,
      ...(context ? { seedContext: context } : {}),
    };
  };
// acquire 的 isAdmitted 每次都会重新求值：插件开关、workspace 身份与 authority 都可能在运行期变化，
// 因此不能在构造时算一次缓存。shouldRetainCurrent 恒为 true，保证关闭插件不会回收在用 Helper。
// 返回 managed?.helper 而非 managed：调用方只关心 helper 能力，不接触代际管理细节。
  const getOrCreateDefaultCuaProductHelper = async (
    context?: CuaProductMcpServerResolverContext,
  ): Promise<DefaultCuaProductHelper | undefined> => {
    const managed = await defaultCuaProductHelperLifecycle.acquire({
      isAdmitted: () =>
        shouldCreateDefaultCuaProductHelper({
          serviceAuthorityMode: options?.serviceAuthorityMode,
          hasRemoteWorkspaceIdentity: Boolean(context?.workspaceIdentity?.trim()),
          hasInjectedResolver: Boolean(options?.cuaProductMcpServerResolver),
          hasBuiltInCuaPlugin: isCuaEnabledForContext(context),
        }),
      shouldRetainCurrent: shouldRetainDefaultCuaProductHelper,
      create: () => createManagedDefaultCuaProductHelper(context),
    });
    return managed?.helper;
  };
// 代际判定只认 lifecycle 当前持有的那个 helper：异步查询过程中可能发生 dispose/重建，
// 旧 helper 的报告与 restart 结果都不再有意义（用 === 比较而不是 id，防止对象被复用）。
  const isDefaultCuaProductHelperCurrent = (helper: DefaultCuaProductHelper): boolean =>
    defaultCuaProductHelperLifecycle.peek()?.helper === helper;
  // Helper 懒启动：宿主启动时仅探测稳定 socket 上是否有一个
  // 自启动（SDK 首调拉起）的 Helper。只 ping，绝不拉起；300ms 预算。probe 结果仅用于
  // 状态展示 / PiP 凭据发现；权限详情与 onboarding 仍走显式 host 流。
// [资源] 只 ping、不拉起：探测自启动（SDK 首次调用拉起）的 Helper 是否已在稳定 socket 上监听。
// 因此本轮新建的 socket 必须在每条出口 destroy，否则状态查询会在 Host 内累积半开连接。
// [失败路径] 300ms 预算 + 单行 JSON 回复判定：任何解析失败/超时/ECONNREFUSED 都收敛为 null（未运行），
// 不能抛出，因为调用方是设置页刷新与 PiP 凭据发现，抛错会把「没装」显示成「出错」。
  const probeStableCuaHelperSocket = async (): Promise<string | null> => {
    const socketPath =
      process.platform === "win32" ? getStableCuaPipeName() : resolveBrokerSocketPath();
    try {
      const { createConnection } = await import("node:net");
      return await new Promise<string | null>((resolve) => {
        const socket = createConnection(socketPath);
        const finish = (value: string | null): void => {
          socket.destroy();
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), 300);
        socket.on("connect", () => {
          clearTimeout(timer);
          socket.write(`{"id":0,"method":"ping","params":{}}\n`);
          let buffer = "";
          socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            if (buffer.includes("\n")) {
              try {
                const nl = buffer.indexOf("\n");
                const reply = JSON.parse(buffer.slice(0, nl)) as { ok?: boolean };
                finish(reply.ok === true ? socketPath : null);
              } catch {
                finish(null);
              }
            }
          });
        });
        socket.on("error", () => {
          clearTimeout(timer);
          finish(null);
        });
      });
    } catch {
      return null;
    }
  };

  // 按需启动：拉起 standalone Helper（稳定 socket）。dev 场景（本 Helper 构建内嵌 dev
  // policy）成对带 unsigned-launcher/external-escape argv，让 ad-hoc 签名的本进程也能过
  // 签名门查询；产品 Helper 不嵌 dev policy，这对 argv 无效（产品签名天然过 Team 门）。
  // 拉起后轮询 ping（5s/100ms），就绪返回 socket 路径，否则 null。
  //
  // dev 判定直接用上游的 isCuaLocalDevelopmentRuntime（@zcode/zcode-cua/broker/server，
  // 即本文件已经用来 import buildHelperOpenArgs 的那个 subpath，可正常导入）。
  //
  // 行为等价性（别误读成安全加固）：上游是 `COMPILED_LOCAL_DEVELOPMENT_RUNTIME &&
  // ZCODE_RUNTIME_ENV!=="production"`，而那个编译期常量只有 scripts/build-cua-helper-app.mjs
  // 会用 define 折叠（Helper bundle）；desktop host bundle 没有该 define，于是回退成
  // `process.env.NODE_ENV !== "production"` —— 正是复制品写的那一项。所以在**当前**打包形态下
  // 两者逐字等价，关门靠的是 ZCODE_RUNTIME_ENV=production（打包态显式注入且不传 NODE_ENV）。
  //
  // 换成上游的收益是消除漂移面：折叠点、因子个数与 fail-closed 方向都由上游一处决定，
  // 哪天 host bundle 也补上 __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__ define（Helper 侧已经有），
  // 编译期门自动生效，不需要再回来改这里。

// 设置页拉起链路单独一个 scope：与 Agent 侧的 Helper 日志分开，排障时能直接区分
// 「用户点开设置页」与「Agent 首次调用 CUA」两条来源。
  const cuaStatusLaunchLog = createServiceLogger("cua-status-launch");
// 设置页的「按需拉起」与 Agent 链路的启动严格分开：这里拉起的 Helper 不带 launcher-pid，
// 300s 无访问即自行休眠，也不进入托管体系，因此不会与 Agent 首次调用拉起的实例抢所有权。
// [资源] 只用 /usr/bin/open 交给 LaunchServices 冷启，随后 5s 内每 100ms ping 一次；超时返回 null，
// 由调用方展示「启动中，请稍后重试」，而不是把冷启动耗时算成权限缺失。
// 参数统一走 buildHelperOpenArgs：设置页不承载 PiP，所以不传 --launcher-pid / --pip-mode。
  const launchStandaloneCuaHelperForStatus = async (): Promise<string | null> => {
    if (process.platform !== "darwin") return null;
    const { existsSync } = await import("node:fs");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const socketPath = resolveBrokerSocketPath();
    let appPath: string | null;
    try {
      appPath = await resolveStandaloneStatusLaunchAppPath({
        env: process.env,
        bundledAppPath: resolveBundledCuaHelperAppPath(),
        exists: existsSync,
        ensureInstalled: (bundledAppPath) =>
          createCanonicalCuaHelperInstaller({
            logger: cuaStatusLaunchLog,
            env: process.env,
            bundledAppPath,
          }).ensureInstalled(),
      });
    } catch (error) {
      cuaStatusLaunchLog.warn(undefined, "CUA Helper install before status launch failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!appPath) return null;
    // Helper 启动参数统一由 buildHelperOpenArgs 构造，避免多处手写导致漏传或漂移。
    // 设置页只读权限探测不承载 PiP，不传 --launcher-pid 和 --pip-mode；
    // exit-log 使用 .settings.exit.log。新增参数应定义在 HelperLaunchSpec 中供调用方共用。
    const args = buildHelperOpenArgs({
      appPath,
      socketPath,
      exitLogPath: `${socketPath}.settings.exit.log`,
      ...(isCuaLocalDevelopmentRuntime(process.env)
        ? { allowUnsignedLauncherLocalDev: true, allowExternalBrokerClientLocalDev: true }
        : {}),
    });
    try {
// [失败路径] open 超时不代表启动失败（LaunchServices 已接单），因此吞掉异常继续 ping：
// 把超时当失败会让用户在冷启动期间反复点击，反而叠加多个 Helper 启动请求。
      await promisify(execFile)("/usr/bin/open", args, { timeout: 5_000 });
    } catch {
      // LaunchServices 已接单也可能超时；继续等 ping。
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await probeStableCuaHelperSocket();
      if (ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };

// Windows 没有 LaunchServices 等价物，只能走托管 host：start() 不 await（fail-open），
// 后续统一用稳定命名管道 ping 判定是否就绪，保证两个平台的返回语义一致（socket 路径或 null）。
  const launchWindowsCuaHelperForStatus = async (): Promise<string | null> => {
    try {
      const managed = await getOrCreateDefaultCuaProductHelper(undefined);
      if (managed) void managed.host.start().catch(() => {});
    } catch {}
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await probeStableCuaHelperSocket();
      if (ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };

  // enabled 与 onCuaPipSessionLifecycle 是否挂上，都由 serviceAuthorityMode 单点决定；
  // 提出来命名，避免下面的启动期诊断与真实取值漂移。
// PiP 会话只属于物理桌面：enabled 与 lifecycle 回调的挂载条件都从这里派生，
// 提前命名为常量是为了让启动期诊断日志与真实取值不会漂移（两者引用同一个变量）。
  const cuaPipSessionEnabled =
    process.platform === "darwin" && options?.serviceAuthorityMode === "desktop-local";
// [并发] PiP 凭据解析优先读托管 host（此时 token 已在内存），否则回退到稳定 socket 探测；
// probe-only 是硬约束——PiP 是展示态，不能因为打开一个卡片就在后台拉起高权限进程。
// 资格由 Helper 按对端签名 identifier 裁决，本进程只声明 role=presentation，不做本地放行判断。
  const cuaPipSessionService = createCuaPipSessionService({
    enabled: cuaPipSessionEnabled,
    resolveCredentials: async () => {
      const host = defaultCuaProductHelperLifecycle.peek()?.helper.macPermissionHost;
      // PiP 客户端以 role=presentation 声明，资格由 Helper 按对端（ZCode 主进程）签名 identifier 裁决。
      if (host?.running && host.socketPath) {
        return {
          socketPath: host.socketPath,
        };
      }
      // 懒启动：无托管 host 时探测稳定 socket 上自启动的 Helper（probe-only，不拉起）。
      const stable = await probeStableCuaHelperSocket();
      return stable ? { socketPath: stable } : undefined;
    },
  });
  // 启动期就把 PiP 投递链的接线状态写出来。dev 实测 PiP 事件一条都没投，而
  // 「enabled=false」与「lifecycle 回调没挂（tracker 整体 undefined、accept 全程 no-op）」
  // 这两种成因在运行期都不产生任何日志，只能靠这行在启动时分辨——重启即可判定，
  // 不必先跑一轮 CUA。scope 沿用 cua-pip-session：已验证该 logger 的 info 会进宿主日志。
  createServiceLogger("cua-pip-session").info(undefined, "[cua-pip-session] wiring resolved", {
    enabled: cuaPipSessionEnabled,
    platform: process.platform,
    serviceAuthorityMode: options?.serviceAuthorityMode ?? null,
    lifecycleWired: options?.serviceAuthorityMode === "desktop-local",
  });
  // Computer Use Helper macOS 权限状态服务：renderer 经 host RPC 查询当前 Helper 的运行态与权限，并在
  // 用户授权后从明确入口精确重启一次 Helper。重启**必须走 resolver.restart()**（不是裸 host.restart），
  // 因为 resolver 优先复用既有 socket/token；裸 host.restart() 可能 fresh 新凭据，使已有 Agent
  // 继续持有旧 transport，无法连接新的 broker。
// [权衡] 重启必须走 resolver.restart()，不能裸调 host.restart()：resolver 会尽量复用既有
// socket/token，而裸重启会 fresh 出新凭据，导致已有 Agent 仍握旧 transport、连不上新 broker。
// 因此即使只想要「重启一下」，也要经过 resolver 这一层，由它决定是否换代际。
  const cuaPermissionService: ICuaPermissionService = {
// 状态查询是只读路径：插件关闭时直接返回不可用，绝不进入 acquire（会把仍被已有 Agent 使用的
// Helper 停掉）。托管 host 不在时才探测稳定 socket，再退化为「未运行，首次使用时自动启动」。
// 每次 await 之后都要重验 isDefaultCuaProductHelperCurrent：查询期间可能发生 dispose，
// 旧代际的权限报告不能再展示给用户（否则会显示一个已不存在的主体的授权）。
    async getStatus(
      workspacePath: string,
      workspaceIdentity?: string,
      queryOptions?: CuaPermissionStatusQueryOptions,
    ): Promise<CuaPermissionStatusResult> {
      if (process.platform !== "darwin" && process.platform !== "win32") {
        return {
          available: false,
          reason: "CUA permissions are only available on macOS and Windows.",
        };
      }
      const context = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
      // 插件关闭只门控后续 Agent；权限页刷新不得进入 acquire，否则会把仍被已有 Agent 使用的 Helper 停掉。
      if (
        !shouldUseCuaPermissionService({
          cuaEnabled: isCuaEnabledForContext(context),
        })
      ) {
        return {
          available: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      // 懒启动：状态查询绝不拉起 Helper。托管 host 在（如刚完成授权流）→ 全量查询；
      // 否则探测稳定 socket 上自启动的 Helper（probe-only）；都没有 → 未运行（首次使用时自动启动）。
// [并发] peek 不 acquire：状态查询绝不能因为「看一眼」就创建高权限进程。
// 拿到后还要验 isDefaultCuaProductHelperCurrent，防止读到已被 dispose 的旧代际。
      const peeked = defaultCuaProductHelperLifecycle.peek()?.helper;
      const helper = peeked && isDefaultCuaProductHelperCurrent(peeked) ? peeked : undefined;
      const host = helper ? helper.macPermissionHost : undefined;
      if (!host || !host.running) {
        // Helper 按需启动：设置页查询 = 拉起 standalone Helper（稳定 socket、
        // 无 launcher-pid → 300s 无访问自动休眠，不进托管体系）。拉起后经稳定 socket 查真值。
        let stable = await probeStableCuaHelperSocket();
        if (!stable) {
          stable =
            process.platform === "darwin"
              ? await launchStandaloneCuaHelperForStatus()
              : await launchWindowsCuaHelperForStatus();
        }
        if (!stable) {
          return {
            available: false,
            reason:
              "ZCode Computer Use is not running; it will start automatically on first Computer Use use.",
            idle: true,
          } satisfies { available: false; reason: string; idle: true };
        }
        // standalone Helper 上直接查权限真值（身份模式，无 token）。
        try {
          const { callBrokerMethod } = await import("@zcode/zcode-cua/broker/helperHealth");
          const report = await callBrokerMethod<{
            grant_owner: string;
            owner?: { display_name?: string };
            accessibility: CuaPermissionState;
            accessibility_probe_ok?: boolean;
            screen_recording: CuaPermissionState;
          }>({
            socketPath: stable,
            method: "permission_status",
            timeoutMs: 3000,
          });
          return {
            grantOwner: report.grant_owner,
            grantOwnerDisplayName: report.owner?.display_name ?? report.grant_owner,
            accessibility: report.accessibility,
            accessibilityProbeOk: report.accessibility_probe_ok === true,
            screenRecording: report.screen_recording,
            screenCaptureProbeOk: false,
          };
        } catch {
          return {
            available: false,
            reason: "ZCode Computer Use is starting up; retry in a moment.",
            idle: true,
          } satisfies { available: false; reason: string; idle: true };
        }
      }
      try {
// 权限报告来自常驻 Helper，但 Screen Recording 的真值必须再用新进程预检（见下方 resolveCuaScreenRecordingState）：
// macOS 撤销授权对已运行进程不生效，直接信它会长期显示 granted。
        const report = await host.queryPermissionStatus();
        if (!helper || !isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        // Screen Recording 的真值必须来自一个新进程：撤销对已运行的常驻 Helper 不生效，
        // 它会一直报撤销前的 granted。拿不到真值时 fail-open 沿用 report 值。
        const screenRecording = await resolveCuaScreenRecordingState(host, report.screen_recording);
        if (!isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        // 真实 screen-capture 探针：TCC screen_recording === "granted" 只说明系统记录了授权，并不保证
        // WindowServer 已对本进程放行像素（wallpaper-frame / SR-not-live 背离）。只有真的抓到非空像素
        // 才算 screen 端到端可用——UI 的"就绪/自动关闭"据此判定。fail-closed：探测抛错/超时一律 false。
        // 用预检后的 state 做门控：预检已判 denied 时没有必要再花一次抓屏。
// TCC 记录 granted 只说明系统登记过授权，不保证 WindowServer 真的放行像素（wallpaper-frame 背离），
// 因此这里再抓一次非空像素；探测抛错/超时一律 false（fail-closed），UI 的「就绪」据此判定。
        const screenCaptureProbeOk = await runCuaScreenCaptureReadinessProbe(
          host,
          screenRecording,
          queryOptions,
        );
        if (!isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        const reportedOwnerDisplayName =
          typeof report.owner?.display_name === "string" ? report.owner.display_name : undefined;
        return {
          grantOwner: report.grant_owner,
          grantOwnerDisplayName: reportedOwnerDisplayName ?? report.grant_owner,
          accessibility: report.accessibility,
          accessibilityProbeOk:
            report.accessibility_probe?.ok === true &&
            report.accessibility_probe?.classification === "functional",
          screenRecording,
          screenCaptureProbeOk,
        };
      } catch (error) {
        return {
          available: false,
          reason: `Could not read Computer Use Helper permission status: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
// 与 getStatus 同口径：插件关闭时不触碰现有 Helper，避免「打开设置页点一下」改变已有 Agent 的运行时。
// permission_granted 分支必须把 onboardingSessionId 透传下去，底层用它做幂等与时序保序；丢参数会
// 让连续授权事件互相覆盖，最终 Helper 停在错误的授权状态上。
    async restartHelper(
      workspacePath: string,
      workspaceIdentity?: string,
      restartOptions?: CuaPermissionRestartOptions,
    ): Promise<CuaPermissionRestartResult> {
      if (process.platform !== "darwin") {
        return {
          ok: false,
          reason: "CUA permissions are only available on macOS.",
        };
      }
      const context = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
      // 与 getStatus 一致：插件关闭时不触碰现有 Helper，避免设置页动作改变已有 Agent runtime。
      if (
        !shouldUseCuaPermissionService({
          cuaEnabled: isCuaEnabledForContext(context),
        })
      ) {
        return {
          ok: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      // 走 resolver.restart()，让 host 尽可能复用 transport；不得通过 disposeWorkspace
      // 重建正在运行的 Agent。
      const helper = await getOrCreateDefaultCuaProductHelper(context);
      const resolver =
        helper && helper.macPermissionHost && isDefaultCuaProductHelperCurrent(helper)
          ? helper.resolver
          : undefined;
      if (!resolver) {
        return {
          ok: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      try {
        if (restartOptions?.reason === "permission_granted") {
          await resolver.restartAfterPermissionGrant(restartOptions.onboardingSessionId);
        } else {
          await resolver.restart();
        }
        if (!helper || !isDefaultCuaProductHelperCurrent(helper)) {
          return {
            ok: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: `Failed to restart ZCode Computer Use: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };
  // 动态工作流的用户选择（docs/dynamic-workflow/launch.md「The user's choice」）：本机设置文件是唯一来源，
  // 每次使用时读取。desktop-attached remote Host 读不到桌面的设置，选择由 desktop 推送
  // （zcodeAgentService.syncDynamicWorkflowUserMode），这里不注入。读取失败按「跟随」处理。
// 动态工作流的用户选择以「本机设置文件」为唯一来源、每次使用时读取；desktop-attached remote 读不到
// 桌面设置，改由 desktop 主动推送（forwardDynamicWorkflowUserMode），所以这里不注入而不是注入空值。
  const resolveDynamicWorkflowUserMode = isDesktopAttachedRemote
    ? undefined
    : async () => (await settingService.get()).dynamicWorkflowMode;
  const codingPlanSubscriptionService = createCodingPlanSubscriptionService({
    apiClient,
    credentialService,
    ...(resolveDynamicWorkflowUserMode ? { resolveDynamicWorkflowUserMode } : {}),
    resolveOffPeakModelSelectionView: async () => {
      await providerRuntime.start();
      return buildOffPeakModelSelectionView(providerRuntime.registryService.getView());
    },
  });
  // OffPeakTaskService 单例在下方 DI register IIFE 中创建（晚于 agent service）；
  // 用前向引用 holder 惰性绑定——offPeak/create 协议请求只会发生在服务集合装配完成后。
  let offPeakTaskServiceForAgent: OffPeakTaskService | undefined;
  // desktop-attached-remote 装配不暴露 Off-Peak 工具面（远程不在支持范围）。
// 闲时工具面按 authority 裁剪：desktop-attached-remote 不在支持范围，装配层直接不给闭包，
// 使协议 handler 因缺依赖而不可用，而不是靠运行期再判一次 authority（两处判定必然漂移）。
  const offPeakToolWiring =
    options?.serviceAuthorityMode === "desktop-attached-remote"
      ? {}
      : {
          resolveOffPeakClientConfig: () => codingPlanSubscriptionService.getOffPeakClientConfig(),
          resolveOffPeakTaskService: () => offPeakTaskServiceForAgent,
        };
  const setWorkspaceProjection =
    options?.setWorkspaceProjection ?? localSettings?.setWorkspaceProjection;
// [事务] 投影在一个显式事务内完成：读目录 → 读项目树 → 计算投影，任何一步抛错都 ROLLBACK。
// 之所以必须先 BEGIN 再读：目录与项目树是两张表，分开读会看到「项目已删、目录还在」的中间态，
// 投影结果会把已删项目重新写回设置。COMMIT 之后才允许对外广播（见 publishProjectChange）。
  setWorkspaceProjection?.(async (settings) => {
    const db = await taskIndexRepo.getOrganizationDatabase();
    const repository = await taskIndexRepo.getProjectRepository();
    db.exec("BEGIN");
    try {
      const directory =
        !options?.projectStorageHostId || options.projectStorageHostId === "local"
          ? readRemoteProjectDirectory(db)
          : { hosts: [], entries: [] };
      const projection = projectWorkspaceSettings(
        repository.readTree({ includeTasks: false }).projects,
        directory,
        settings,
      );
      db.exec("COMMIT");
      return projection;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  });
// 变更广播的时序被刻意固定：先让设置 owner 从最新目录派生旧字段（update 是空 patch，只触发重算），
// 再广播 state:projects。反序会让订阅者先拿到事件、后用旧字段渲染，出现闪一下再纠正的抖动。
  const publishProjectChange = async () => {
    // SQLite 已提交；旧字段只能在设置 owner 的锁内从最新目录派生。
    if (setWorkspaceProjection) await settingService.update({});
    await broadcastService.send({ channel: "state:projects", payload: {} });
  };
// controller 标志表示「本 Host 是否是该库的写入者」：只有 projectStorageHostId 为空或 local 时才为 true。
// 远端 Host 共享同一张表但不能直接写，必须经 controller 走连接，否则会出现两套目录事实。
  const remoteProjectService = createRemoteProjectService({
    ...options?.remoteProjectConnection,
    controller: !options?.projectStorageHostId || options.projectStorageHostId === "local",
    database: () => taskIndexRepo.getOrganizationDatabase(),
    afterChange: publishProjectChange,
  });
// 项目服务是项目/任务目录的唯一读写门；resolveHost 允许按 hostId 路由到别的 Host 实例，
// 用于「本机 UI 操作远端 workspace」的场景，此时本地只做转发，不缓存远端目录。
  const projectService = createProjectService({
    directories: {
      home: async () => (await systemService.info()).homedir,
      read: (params) => fileService.readdir(params),
    },
    ownerHostId: options?.projectStorageHostId,
    resolveHost: options?.resolveProjectHostService,
    repository: () => taskIndexRepo.getProjectRepository(),
    workspaceDirectory: join(projectDataRoot(), "workspace"),
    afterChange: publishProjectChange,
  });
// 分组解析只读各所属 Host 的权威目录，且不因分组展示而建连接或启动 Agent；
// 跨 Host 的引用在结果里按 hostId+workspacePath 双重校验，避免同名 task 串到别的 workspace。
  const taskGroupService = createTaskGroupService({
    database: () => taskIndexRepo.getOrganizationDatabase(),
    resolveTasks: async (refs) => {
      // 只读所属 Host 的权威目录；项目路由不会为分组建立连接或启动 Agent。
      const hostIds = [...new Set(refs.map((task) => task.hostId))];
      const results = await Promise.all(
        hostIds.map(async (hostId) => {
          const tree = await projectService.readTree({ hostId, includeDeletedTasks: true });
          const facts = new Map(
            [
              ...tree.tasks,
              ...(tree.deletedTasks ?? []).map((task) => ({ ...task, deleted: true })),
            ].map((task) => [groupTaskKey(task), task]),
          );
          return refs
            .filter((ref) => ref.hostId === hostId)
            .flatMap((ref) => {
              const fact = facts.get(groupTaskKey(ref));
              return fact && fact.hostId === ref.hostId && fact.workspacePath === ref.workspacePath
                ? [{ ...fact, ...ref }]
                : [];
            });
        }),
      );
      return results.flat();
    },
    afterChange: () => broadcastService.send({ channel: "state:task-groups", payload: {} }),
  });
// 执行前准备把 hostId 写进返回结构：Agent 侧据此决定会话归属，local 是显式默认值而不是 undefined，
// 否则远端路由会把「未指定」当成「随便挑一个 Host」。
  const prepareProjectExecution = async (projectId: string) => ({
    ...(await projectService.prepareSession({ projectId })),
    hostId: options?.projectStorageHostId ?? "local",
    workspaceIdentity: undefined,
  });
// Agent 服务是进程内资源大户（子进程、MCP stream、turn 状态），装配期只注入依赖与策略，
// 真正的 spawn 发生在会话级请求。下列注入点的共同约束：只能传闭包或纯值，不能传已启动的实例，
// 否则 Agent 重启后会持有上一代对象的引用（典型故障：terminal 输出写到已关闭的 channel）。
  const zcodeAgentService = createZCodeAgentService({
    prepareProjectExecution,
    prepareSessionCreation: async (target) =>
      (await taskIndexRepo.getProjectRepository()).reserveCreatedTask({
        task: { ...target, taskId: target.sessionId },
        projectId: target.projectId,
        additionalDirectories: target.additionalDirectories,
      }).additionalDirectories,
    resolveSessionDirectories: async (target) =>
      (await projectService.resolveSessionDirectories({ ...target, taskId: target.sessionId }))
        .additionalDirectories,
    ...(agentAccountProviderConfigSource
      ? { accountProviderConfigSource: agentAccountProviderConfigSource }
      : {}),
    accountRequestAuthService,
    ...(modelSelectionReadinessSource ? { modelSelectionReadinessSource } : {}),
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    ...offPeakToolWiring,
    // 动态工作流灰度：与 Off-Peak 不同，
    // 这里不按 serviceAuthorityMode 裁剪——SSH/WSL/Docker 的 desktop-attached-remote Host
    // 是它自己那些 workspace 的唯一裁决者，灰度开启时远程 workspace 同样提供工作流。
    resolveDynamicWorkflowClientConfig: () =>
      codingPlanSubscriptionService.getDynamicWorkflowClientConfig(),
    ...(resolveDynamicWorkflowUserMode ? { resolveDynamicWorkflowUserMode } : {}),
    forwardDynamicWorkflowUserMode: options?.forwardDynamicWorkflowUserMode,
    commandResolver: options?.zcodeAgentCommandResolver,
    presentationSurface: resolveZCodeAgentPresentationSurface({
      runtimeSurface: options?.agentTelemetry?.runtimeSurface,
      serviceAuthorityMode: options?.serviceAuthorityMode,
      desktopContextPromptEnabled,
    }),
    onAutomationManualRunRequested: options?.onAutomationManualRunRequested,
    // createLocalServices 虽然暴露了 reporter 注入点，旧装配却没有继续传给
    // ZCodeAgentProcessManager，导致 host 永远不向 main 上报 Agent spawn/exit，进程监控器
    // 因而看不到实际运行的 Agent，也无法验证只读到可写升级是否复用同一进程。
    processLifecycleReporter: options?.processLifecycleReporter,
    spawnFallbackCwd: options?.zcodeAgentSpawnFallbackCwd,
    // browser-use：host→main 执行桥透传给 agent service 的 onRequest browserExecute 路由。
    browserControlExecutor: options?.browserControlExecutor,
    // 机器人凭据只归属于授权 Host；远端独立服务不能借用本机配置扩大读取范围。
// [权衡] 机器人凭据只归属于授权 Host：desktop-attached remote 有私有 relay 频道时必须走 relay，
// 没有则直接报错，绝不回退到本机 bots 配置——那等于让远端会话借用本机身份向外发消息。
    channelReplyExecutor: async (value) => {
      const request = channelReplyHostRequestSchema.parse(value);
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return channelReplyResultSchema.parse(
          await options.topicResourceRelayChannel(request).call("reply", request),
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop channel reply peer unavailable");
      const bots = services.getOptional(IBotsService);
      if (!bots?.replyToChannel) throw new Error("Bot channel reply unavailable");
      return bots.replyToChannel(request);
    },
// topic-resource 的两条取数路径互斥且必须显式选择：desktop-attached remote 走私有 relay 频道，
// 本地 Host 直接读本机 bots 服务。禁止在 remote 场景回退到本地 bots——那会让远端会话读到本机话题。
    topicResourceExecutor: async (request, signal) => {
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return readTopicResourceFromRelay(
          options.topicResourceRelayChannel(request),
          request,
          signal,
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop topic resource peer unavailable");
      const bots = services.getOptional(IBotsService);
      if (!bots?.readTopicResource) throw new Error("Topic resource service is unavailable");
      return bots.readTopicResource({ ...request, signal });
    },
    topicResourceValidator: async (request, signal) => {
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return validateTopicResourceFromRelay(
          options.topicResourceRelayChannel(request),
          request,
          signal,
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop topic resource peer unavailable");
      const bots = services.getOptional(IBotsService);
      if (!bots?.validateTopicResource)
        throw new Error("Topic resource authorization is unavailable");
      return bots.validateTopicResource({ ...request, signal });
    },
    // 官方 Server MCP 身份头：host 是唯一身份权威，Agent 经反向请求索取。
    // Provider 存在性读取正式 Model Selection View；不恢复旧 Provider Snapshot。
// 官方 Server MCP 的身份头由 host 生成：Agent 只发起反向请求，不自持凭据；Provider 是否存在
// 一律读正式 Model Selection View，不恢复旧的 Provider Snapshot（那是另一套会漂移的事实）。
    officialMcpAuthHeadersResolver: createOfficialMcpAuthHeadersResolver({
      accountRequestAuthService,
      credentialService,
      modelSelectionService: providerRuntime.modelSelection,
    }),
    // host 是身份权威边界：provenance/origin 必须在这里再校验一次，不能只依赖 agent
    // adapter 的 fetch wrapper。判定实现与 CLI 侧共用 @zcode/shared 的同一份，避免分叉。
    // origin 解析复用 resolveCurrentZCodeEndpointOrigin——与闲时任务同口径（含 settings
    // 覆盖），否则会出现"闲时任务能连、官方 MCP 连不上"。
    // dev 开关必须同样传入，否则本地自测会被 host 单方面拒绝。
// [安全边界] provenance/origin 必须在 host 侧再校验一次，不能只依赖 agent adapter 的 fetch wrapper：
// adapter 可被绕过，host 是信任判定的最后一道。origin 解析复用 resolveCurrentZCodeEndpointOrigin，
// 与闲时任务同口径（含 settings 覆盖），否则会出现「闲时能连、官方 MCP 连不上」的割裂。
    officialMcpTrustedOrigins: createOfficialMcpTrustedOriginRegistry({
      devTrustedOriginsRaw: process.env[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
      resolveZCodeApiOrigin: resolveCurrentZCodeEndpointOrigin,
    }),
// CUA 操作状态是对物理桌面的投影，只有 desktop-local 可以上报：远端 Host 把自己的 turn 投影到
// 本机屏幕会显示错误的鼠标/键盘状态，也会误导用户以为远程操作发生在本机。
    cuaOperationStateReporter: shouldEnableCuaOperationStateReporter({
      serviceAuthorityMode: options?.serviceAuthorityMode,
      hasReporter: Boolean(options?.cuaOperationStateReporter),
    })
      ? options?.cuaOperationStateReporter
      : undefined,
    // ZCode 只发布 turn/session 事实；面板 terminal policy 由 producer coordinator 决定。
    ...(options?.serviceAuthorityMode === "desktop-local"
      ? {
          onCuaPipSessionLifecycle: (_workspace, event) => {
            void cuaPipSessionService.publishLifecycle(event);
          },
        }
      : {}),
    // 设置页的 HTTP 代理、No Proxy + 自定义 CA 按 spawn 时读取注入 agent 子进程 env，
    // 覆盖模型 API / MCP / Bash 出口流量并信任用户显式配置的证书；改动后下次启动 agent 生效。
// [事务] Agent spawn env 是「设置 + provider + 网络 + CUA + 遥测」的一次性快照，必须在 spawn 前全部
// 解析完成：子进程不会重读设置，改动只在下次 spawn 生效（这也是文档里「改代理需重启 Agent」的根因）。
// 顺序上先 await settingService.get() 与 providerRuntime.start()，确保内置 provider 文件路径已物化。
// 代理/CA 覆盖模型 API、MCP 与 Bash 出口流量；CUA 的 broker socket/token 只在此处注入，绝不写盘。
    resolveSpawnEnv: async (context) => {
      const [settings] = await Promise.all([settingService.get(), providerRuntime.start()]);
      // 本地 Host 准备解析快照；远程 CLI 继续由自己的文件 loader 读取和迁移配置。
      if (!isDesktopAttachedRemote) await subagentsService.prepareRuntimeState(context);
      const agentNetwork =
        isDesktopAttachedRemote && options?.remoteAgentNetwork
          ? options.remoteAgentNetwork
          : {
              httpProxy: settings.httpProxy,
              noProxy: settings.httpProxyNoProxy,
            };
// [并发] 每次 spawn 都新发一个随机 plugin authority token：同一进程内多个 Agent 不能共用令牌，
// 否则一个 Agent 被回收后仍能用旧令牌连 broker。Windows 额外下发 recipe（含 hostPid），
// recipe 解析失败时改写为 BROKER_UNAVAILABLE，让插件 fail-closed 而不是去猜管道名。
      const cuaPluginEnabled = isCuaEnabledForContext(context);
      let cuaProductHelperEnv: Record<string, string> = {};
      if (cuaPluginEnabled && (process.platform === "darwin" || process.platform === "win32")) {
        const brokerSocket =
          process.platform === "win32" ? getStableCuaPipeName() : resolveBrokerSocketPath();
        cuaProductHelperEnv = {
          [BROKER_SOCKET_ENV]: brokerSocket,
          [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: randomBytes(16).toString("hex"),
        };
        if (process.platform === "win32") {
          const recipe = await resolveStableCuaWinRecipe();
          if (recipe) {
            cuaProductHelperEnv["ZCODE_CUA_WIN_HELPER_RECIPE"] = JSON.stringify({
              ...recipe,
              hostPid: process.pid,
            });
          } else {
            cuaProductHelperEnv = {
              [BROKER_UNAVAILABLE_ENV]:
                "broker_unavailable: windows helper recipe could not be resolved",
            };
          }
        }
      }
      const telemetryEnv = getCapturedZCodeAgentTelemetryEnv();
      const telemetryConfigured = Boolean(
        telemetryEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || telemetryEnv.OTEL_EXPORTER_OTLP_ENDPOINT,
      );
      const telemetryProfile = telemetryConfigured
        ? await oauthCredentialRepo.loadActiveUserProfile().catch(() => null)
        : null;
      const telemetryDeviceMid = telemetryConfigured
        ? options?.agentTelemetry?.getDeviceMid?.()?.trim()
        : undefined;
      // Host 是旧配置迁移的唯一写入者。Agent spawn 前等待初始化完成，避免 Worker
      // 先拿到尚不存在的 provider_config.json 并发布短暂空 Registry。
      await providerConfigRuntime.start();
      return {
        ...buildAgentRuntimeEnv({
          httpProxy: agentNetwork.httpProxy,
          noProxy: agentNetwork.noProxy,
          caCertPath: settings.httpProxyCaCertPath,
        }),
        // 把 host 解析出的权威 origin（含 settings 覆盖）下发给 agent，否则 agent 侧只按
        // env 推导，test env + 自定义端点时两侧信任判定的输入分叉、官方 MCP 整体 fail closed。
// 把 host 解析出的权威 origin 下发给 Agent：否则 agent 只按 env 推导，在 test env + 自定义端点时
// 两侧信任判定输入分叉，官方 MCP 会整体 fail closed（表现为无报错但工具不可用）。
        ...buildAgentEndpointOriginEnv(await resolveCurrentZCodeEndpointOrigin()),
        // broker 凭据（socket/token）注入 agent spawn env，让内置 zcode-cua plugin 的
        // computer-use MCP server 经 __zcode-plugin-host 恢复 token 后连上 broker。
        ...cuaProductHelperEnv,
        ...buildAgentTelemetrySpawnEnv({
          deviceMid: telemetryDeviceMid,
          runtimeSurface: options?.agentTelemetry?.runtimeSurface ?? "remote_workspace_host",
          telemetryEnv,
          userId: telemetryProfile?.id,
        }),
// Built-in Active 路径按当前 Endpoint 隔离，不能用同步固定路径 getter 读取：必须等本轮 Endpoint
// Source 完成解析与物化后再下发，否则 Agent 会读上一端点遗留的内置配置。
        ...createNodeProviderRuntimePathEnv({
          // Built-in Active 路径按当前 Endpoint 隔离，不能通过同步的固定路径
          // getter 读取；Agent spawn 必须等待本轮 Endpoint Source 完成解析和物化。
          zcodeBuiltinFilePath: await providerConfigRuntime.resolveZCodeBuiltinActiveFilePath(),
          personalFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        }),
      };
    },
    ...(!isDesktopAttachedRemote
      ? { readSubagentRuntimeConfig: subagentsService.readRuntimeConfig }
      : {}),
    ...(isDesktopAttachedRemote
      ? { sessionRuntimePreferencesAuthority: "external" as const }
      : {
          sessionRuntimePreferencesAuthority: "local" as const,
// 本地权威侧把设置投影成会话运行时偏好；预算策略固定为共享默认值（预算已统一，不能把可选远端
// 配置当成本地/手机 shared-host 建会话的前置条件）。未显式关闭即视为开启的字段用 !== false，
// 与设置默认值语义一致，避免旧版本缺字段时被读成关闭。
          resolveSessionRuntimePreferences: async (scope) => {
            // 预算已统一，不能把可选远端配置作为本地/手机 shared-host 建会话的前置条件。
            const settings = await settingService.get();
            const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
            return {
              askUserQuestionAutoResolutionEnabled:
                settings.askUserQuestionAutoResolutionEnabled !== false,
              nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
              toolSearchMode: settings.toolSearchMode ?? "off",
              memoryEnabled: settings.memoryEnabled === true,
              modelContextBudgetStrategy,
              // user-execution 只消费 Shell；共享默认策略是统一 result schema 的兼容占位，
              // 不会覆盖 runtime-materialization 阶段已经固定的 strategy。
              ...(scope === "user-execution" && settings.integratedTerminalShell
                ? { integratedTerminalShell: settings.integratedTerminalShell }
                : {}),
            };
          },
        }),
  });
  providerConnectivityAgentService = zcodeAgentService;
  // Helper health probe 短暂超时不应在 Computer Use turn 中途回收 Agent。resolver 会把 restart
  // 推迟到下一个 request/turn 边界；若 broker 确实已失效，当前 turn 会自然失败并由下一次请求恢复。
// [并发] 此处完成前向引用赋值：此后 resolver 才能判断「现在重启 Helper 会不会打断进行中的 CUA turn」。
// Helper 健康探测的短暂超时不会在 turn 中途回收 Agent——resolver 把 restart 推迟到下一个请求边界，
// 若 broker 确实失效，当前 turn 自然失败并由下一次请求恢复，这是刻意的 fail-soft。
  hasActiveTurnRef = () => zcodeAgentService.hasActiveCuaOperationTurn();
  // desktop-continuous UI 直接订阅 zcodeSessionService，绕开 ZCode task adapter 的
  // mapServiceEvent 路径，导致 task_complete 永远不会写回 sqlite，侧边栏 spinner 不停。
  // 在 services 层装配一个共享的 taskIndexRepo + syncer，session 任意入口都会唤醒
  // shadow 订阅，把 runtime 终态收敛进 sqlite。
// desktop-continuous UI 直接订阅 zcodeSessionService，绕过了 task adapter 的 mapServiceEvent，
// 于是 task_complete 永远不会写回 sqlite、侧边栏 spinner 不停。因此在 services 层挂一个共享 syncer：
// 任意 session 入口产生的终态都会收敛进 tasks-index，与 UI 走哪条订阅无关。
  const zcodeTaskIndexSyncer = createZCodeTaskIndexSyncer({
    agentService: zcodeAgentService,
    taskIndexRepo,
  });
  // 自动归档只由这里的定时扫描触发（启动首轮 + 每小时 + 设置变更补扫）；readTree 与任务点击
  // 都不再执行 archiveInactive。判据仍排除 syncer 观察到的非终态会话，不为扫描启动 CLI。
// 自动归档的唯一触发点就是这个定时扫描（启动首轮 + 每小时 + 设置变更补扫）；readTree 与任务点击
// 都不再执行 archiveInactive。判据排除 syncer 观察到的非终态会话，且不为扫描启动 CLI（只改库）。
  const taskAutoArchiveScheduler = createTaskAutoArchiveScheduler({
    readPolicy: async () => {
      const settings = await settingService.get();
      if (!settings.taskAutoArchiveEnabled) return null;
      const days = Math.max(1, Math.floor(settings.taskAutoArchiveOlderThanDays ?? 30));
      return {
        cutoff: Date.now() - days * 86_400_000,
        activeTasks: zcodeTaskIndexSyncer.activeTaskRefs(),
      };
    },
    repository: () => taskIndexRepo.getProjectRepository(),
    afterChange: publishProjectChange,
  });
  // The plugin can be toggled at runtime. Do not let a previously created resolver continue
  // health-checking/restarting Helper after disable, and create it lazily after enable.
  // 动态 resolver：isPluginEnabled 与 helper 创建用同一个 isCuaEnabledForContext 门控（dev mode 一致），
  // 避免开发场景下 resolver pass-through 而 helper 已建的割裂。
// 插件可在运行期开关：关闭后旧 resolver 必须立刻停止健康检查/重启，重新开启后再懒建。
// isPluginEnabled 与 helper 创建共用 isCuaEnabledForContext，避免 dev mode 下「resolver 放行但
// helper 已建」的割裂；getResolver 只 peek 不 acquire，保证查询路径不会意外拉起进程。
  const defaultCuaProductMcpServerResolver = createDynamicCuaProductMcpServerResolver({
    isPluginEnabled: (context) => isCuaEnabledForContext(context),
    getResolver: async () => {
      // peek-only——resolver 属托管 host 体系，host 未建时返回 undefined（懒启动下
      // CUA 经 node_repl + 稳定 socket，不依赖此 resolver）；绝不在此 acquire。
      const helper = defaultCuaProductHelperLifecycle.peek()?.helper;
      return helper && isDefaultCuaProductHelperCurrent(helper) ? helper.resolver : undefined;
    },
    isResolverCurrent: (resolver) =>
      defaultCuaProductHelperLifecycle.peek()?.helper.resolver === resolver,
  });
// 注入优先：特殊宿主（测试、定制打包）可以替换 resolver，默认实现才走动态 delegate。
  const cuaProductMcpServerResolver =
    options?.cuaProductMcpServerResolver ?? defaultCuaProductMcpServerResolver;
// session 服务是 turn 生命周期的所有者：它同时持有 agentService（执行侧）与 syncer（落库侧），
// CUA resolver 也在这里注入，使得 MCP server 列表与 session 代际能够一起换代。
  const zcodeSessionService = createZCodeSessionService({
    agentService: zcodeAgentService,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    cuaProductMcpServerResolver,
  });
// Git sidecar 属于目标 Environment：初始模型直接读同一 Host 的 Model Selection View，
// 不再经临时 Agent workspace state 反推模型与 reasoning（那条路会在无会话时拿到过期选择）。
  const gitCommitMessageGenerator = new GitCommitMessageGenerator({
    currentModelProvider: {
      async readCurrentModel() {
        // Git sidecar 属于目标 Environment；初始模型直接读取同一 Host View，
        // 不再通过临时 Agent workspace state 反推模型与 reasoning。
        return (await providerRuntime.modelSelection.getView()).preferredSelection ?? null;
      },
    },
    textGenerator: {
      async generateText(params) {
        return await zcodeAgentService.generateWorkspaceText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          selection: params.selection,
          prompt: params.prompt,
          querySource: params.querySource,
        });
      },
    },
    logger: createServiceLogger("git-commit-message"),
  });
  const gitService = createGitService({
    commitMessageGenerator: gitCommitMessageGenerator,
  });
  // task wrapper 由 ZCode task service adapter 提供；核心 session 状态由 ZCode agent server 维护。
// task 包装层只提供协议适配（task 词 → session 词）；真正的 session 状态由 Agent 服务维护，
// 因此这里拿到的是 agentService + syncer + settingService 三者的组合，而不是另一份任务状态。
  const zcodeTaskService = createZCodeTaskServiceAdapter({
    zcodeAgentService,
    taskIndexRepo,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    settingService,
    cuaProductMcpServerResolver,
  });
// Bot 状态与项目绑定同一份 sqlite：repo 懒建连接，构造本身不产生 IO。
  const botsRepo = new BotsRepo();
  const botLog = createServiceLogger("bots");
// Bot 复用窗口已有的 Source 连接：只有注入 resolveBotProjectConnection 时才建运行时，
// 否则远端 Bot 会走 main 新建 attachment，违反「一个窗口一个 Local Host」的连接模型。
// readBoundTargets 只返回带 workspaceIdentity 的绑定：身份缺失的旧数据无法路由，直接跳过。
  const botRemoteWorkspaceService = options.resolveBotProjectConnection
    ? createBotProjectRuntime({
        remoteProjectService,
        resolveOnline: options.resolveBotProjectConnection,
        onConnectionsChanged: (listener) =>
          broadcastService.onMessage((event) => {
            if (event.channel === "state:projects") listener();
          }),
        readBoundTargets: async () =>
          Object.values((await botsRepo.readState()).bots).flatMap((context) =>
            context.workspaceIdentity
              ? [
                  {
                    workspacePath: context.workspacePath,
                    workspaceIdentity: context.workspaceIdentity,
                    hostId: context.hostId,
                  },
                ]
              : [],
          ),
        readRuntimePreferences: async () => {
          const settings = await settingService.get();
          return {
            askUserQuestionAutoResolutionEnabled:
              settings.askUserQuestionAutoResolutionEnabled !== false,
            modelIoFullRetentionEnabled: settings.modelIoFullRetentionEnabled === true,
          };
        },
        warn: (message) => botLog.warn(message),
      })
    : undefined;
// OAuth 服务与 credentialService 共用同一存储：登录态只有一份，logout handler 也由它驱动，
// 保证「退出登录」与「凭据被判定损坏」走完全相同的派生清理路径。
  const oauthService = createOAuthService(credentialService, {
    apiClient,
    onProviderLogout: handleOAuthProviderLogout,
  });
// JWT 失效处理是异步旁路：失败只 warn，不向调用方传播——401 已经发生过，
// 再抛错只会把「登录失效」变成「请求异常」，让 UI 误判为网络问题。
  const zcodeJwtLogoutLogger = createServiceLogger("zcode-jwt-logout");
// [并发] 条件退出本身已串行去重，但等待旧候选期间到来的新凭据 401 不能被丢弃，所以这里不排队、
// 只按「是否真正清理了队列内的旧会话」决定是否广播过期：401 分类后用户可能已完成新登录，
// 此时广播会让刚登录的 UI 被踢回未登录态。
  zcodeJwtLogoutHandlerRef.current = (input, headers) => {
    // 条件退出本身已串行去重；不能丢弃等待旧候选期间到来的新凭据 401。
    void oauthService
      .logoutIfCurrentCredentialRequest(input, headers)
      .then((invalidated) => {
        // 401 分类后可能已完成新登录；只有队列内真正清理的旧会话才广播过期。
        if (invalidated) {
          void broadcastService.send({
            channel: ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
            payload: {},
          });
        }
      })
      .catch((error) => {
        zcodeJwtLogoutLogger.warn("ZCode JWT logout failed", { error });
      });
  };
  // Desktop Host 曾从 Settings View 再扫描一次 Account Provider，既绕开
  // Registry 的 entitlement/executable 事实，也在多个套餐同时可见时无法唯一选择。
  // 闲时服务与 Host 派发必须共享同一个 Registry-backed 凭据解析闭包。
// 闲时服务与 Host 派发必须共享同一个 Registry-backed 凭据解析闭包：过去在 Settings View 里另扫一遍
// Account Provider，既绕开 Registry 的 entitlement/executable 事实，又在多套餐可见时无法唯一选择。
// [失败路径] 候选数不为 1 一律返回 null（宁可不跑也不猜）：猜错的代价是用 A 账号额度打 B 家网关。
  const offPeakCredentialResolverDeps = {
    credentialService,
    accountRequestAuthService,
// 读的是 Registry 最近完成的快照而不是 start() 的首次就绪：账号后到或切换套餐后，首次快照已过期。
// 只接受 zhipu-account 的 individual/team coding plan 两种 access，其余 provider 一律不参与闲时派发。
    resolveAccountProvider: async () => {
      await providerRuntime.start();
      // start 缓存的是首次就绪；账号后到或切换后必须读 Registry 最近完成的快照。
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      const providers = snapshot.resolution.registryProviders.filter(
        (candidate) =>
          candidate.config.access.type === "zhipu-account" &&
          (candidate.config.access.mode === "individual-coding-plan" ||
            candidate.config.access.mode === "team-coding-plan"),
      );
      if (providers.length !== 1) return null;
      const provider = providers[0]!;
      const config = provider.config;
      const staticAccess = zcodeProviderAccountAccessSchema.parse(config.access.toJSON());
      const access = await accountRequestAuthService.resolveAccessCurrent(staticAccess);
      if (!access) return null;
      return {
        providerId: provider.providerId,
        access: zcodeAccountAccessSchema.parse(access),
        ...(config.api?.baseUrl ? { baseURL: config.api.baseUrl } : {}),
      };
    },
  };
// 闲时鉴权按 ticket 现算而不缓存：ticket 与当前登录态绑定，缓存会把上一轮的身份带到下一轮。
  const buildOffPeakRequestAuthForTicket: OffPeakRequestAuthBuilder = async (ticketId) =>
    buildOffPeakRequestAuth({
      credentials: await resolveOffPeakCredentials(offPeakCredentialResolverDeps),
      ticketId,
    });
// 文件服务的搜索过滤策略由 Host 注入：默认实现来自 browser-safe 契约包，后续规则来源变化只需换注入，
// 不需要改服务内部（否则 Host 与 Web 端会各有一套匹配规则）。
  const fileService = createFileService({
    workspaceFileSearchFilter: options?.workspaceFileSearchFilter,
  });
// 预览 URL 只在 Host 侧签发：本地路径必须先经 Main 登记授权才可读，远端 workspace 没有该授权口，
// 因此这里注入的是可选的 authorizeLocalMediaPreviewPath（缺失即拒绝本地预览）。
  const mediaPreviewService = createMediaPreviewService({
    fileService,
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
  });
// 分享运行时始终走真实 API：测试/Mock 必须在单测或 Web fixture 里显式注入，
// 不能因为开发环境就默认生成只存在于进程内存的 mock-share 链接（用户会拿到打不开的地址）。
  const conversationShareClient = new ConversationShareHttpClient({
    // 分享运行时始终走真实 API；测试/Mock 场景应在 service 单测或 Web fixture 中显式注入，
    // 不能让开发环境默认生成仅存在于进程内存的 mock-share 链接。
    apiClient,
    baseUrl: buildRuntimeZCodeApiUrl(process.env, "/api/v1"),
    tokenProvider: async (): Promise<string | null> => {
      const activeProvider = await oauthCredentialRepo.getActiveProvider();
      if (!activeProvider) {
        return null;
      }
      const tokenSet = await oauthCredentialRepo.loadTokenSet(activeProvider);
      return tokenSet?.zcodeJwtToken ?? tokenSet?.accessToken ?? null;
    },
  });
// 远端 workspace 不支持会话发布（封面/产物都在桌面侧），用显式 Unsupported 实现而不是抛错，
// 让 UI 能拿到稳定错误文案；本地则走真实 HTTP 客户端与本地 artifact source，不生成内存 mock。
  const conversationShareService: IConversationShareServiceType = isDesktopAttachedRemote
    ? createUnsupportedConversationShareService({
        message: "Conversation publishing is not available for remote workspaces",
      })
    : new ConversationShareService({
        zcodeAgentService,
        zcodeSessionService,
        client: conversationShareClient,
        artifactSource: createLocalConversationShareArtifactSource(),
      });
  // 注册链上的懒工厂（如 OffPeak）会各自创建 tasks-index sqlite repo；先收集到本数组，
  // services 集合建好后在 return 前统一登记进 sharedSqliteRepos 侧表
// [资源] 注册链里的懒工厂（如 OffPeak）会各自 new tasks-index repo，但注册链求值期 services 常量
// 尚未初始化，无法直接登记 WeakMap。因此先收集到本数组，集合建好后统一写入 sharedSqliteRepos。
  const sqliteReposToClose: Array<{ close(): void }> = [];
// 营销素材登记表同时服务「本机已发布」与「云内容缓存」：allowLoopback 仅在 test/development 打开，
// 生产不允许素材指向 127.0.0.1，否则渲染层会去拉本机端口（既是 SSRF 面，也会在用户机上失败）。
  const marketingAssets = createMarketingAssetRegistry({
    allowLoopback: ZCODE_ENV === "test" || process.env.NODE_ENV === "development",
  });
// 注册链按「依赖已就绪」顺序书写：前面 register 的服务可以被后面的工厂同步取用，反之只能惰性调用。
// 这里的每个注册都是接口 token → 实例的映射，重复 token 会被集合覆盖而不是报错，因此新增注册前
// 必须先确认该接口尚未在链上出现过（覆盖会让最早注册的实例变成无人释放的孤儿）。
  const services = new ServiceCollection()
    .register(
// 营销触达是只读出站集成：token/deviceMid 都现取，快照回调交给素材登记表，
// 不在 Host 内缓存用户画像。
      IMarketingTouchService,
      createMarketingTouchService({
        apiClient,
        getToken: () => credentialService.load("zcodejwttoken"),
        getDeviceMid: () => options?.agentTelemetry?.getDeviceMid?.(),
        baseUrl: buildRuntimeZCodeApiUrl(process.env, "/"),
        appVersion: ZCODE_VERSION,
        onSnapshot: (snapshot) => marketingAssets.accept(snapshot),
      }),
    )
// 文件 / 预览 / 云内容 / Git 属于本地能力面：它们全部依赖真实文件系统，远端 Host 只会在自己进程内
// 使用自己的实现，绝不跨 Host 共享（共享会让远端会话读到桌面磁盘）。
    .register(IFileService, fileService)
// 预览与云内容服务都只在本进程成立：前者依赖本机授权登记，后者把已发布素材缓存到本机目录，
// 二者的 cacheRoot 由 Host 生成（含随机 UUID），避免多窗口/多代际共享同一缓存目录互相覆盖。
    .register(IMediaPreviewService, mediaPreviewService)
    .register(
// [资源] 云内容服务实现了 disposeAllAndWait：缓存目录需要异步清理，属于可等待释放的一条。
      ICloudContentService,
      createCloudContentService({
        publishedAssets: marketingAssets,
        cacheRoot: join(getContentAppConfigDir(), "cache", "content-bundles", randomUUID()),
      }),
    )
// Git 服务与 checkpoint 服务成对注册：前者面向用户仓库操作，后者只写内部索引目录，
// 两者共享 workspace 解析结果，但都不缓存仓库状态（用户可能在外部改分支）。
    .register(IGitService, gitService)
    .register(IGitCheckpointService, gitCheckpointService)
// 系统 / onboarding / 凭据三个注册都属于「本地事实」：远端 Host 上它们代表远端机器与远端用户，
// 因此同一次会话里不能混用两侧的 homedir 或 onboarding 状态。
    .register(ISystemService, systemService)
    .register(ITerminalService, createTerminalService({ settingService }))
// 设置与凭据必须早于所有依赖它们的服务注册：消费方在构造期就会读一次设置，此时注入实例必须已是
// 同一个权威对象，否则拿到的是一份「看起来一样但不会同步」的副本。
    .register(ISettingService, settingService)
    .register(IOnboardingRecordService, onboardingRecordService)
// 凭据与广播是「基础设施型」注册：几乎每个域都依赖它们，因此必须早于业务服务出现，
// 且不允许下游再 new 一份（否则失效广播只覆盖其中一份）。
    .register(ICredentialService, credentialService)
// 广播服务的生命周期跟随 Host：parentPort 关闭后发送即静默丢弃，不能抛错打断服务的收尾流程。
    .register(IBroadcastService, broadcastService)
// [资源] task 服务持有会话包装与停止生成能力，属于需要 disposeAll 的服务；
// 它必须注册在 agent/session 之后，否则 adapter 取不到执行侧接口。
    .register(IZCodeTaskService, zcodeTaskService)
// Agent / Session / Task 三个服务互为闭环：adapter 只做协议翻译，session 持有 turn 生命周期，
// agent 执行。注册顺序保证 getOptional 在任一 handler 内都能拿到另外两者，避免运行期再判空降级。
    .register(IZCodeAgentService, zcodeAgentService)
    .register(IZCodeSessionService, zcodeSessionService)
    .register(IProjectService, projectService)
// 任务分组依赖项目服务读各 Host 目录，注册在项目服务之后只是为了让读者看清依赖方向，
// 实际调用发生在请求期，组装期不会触发跨 Host 读取。
    .register(ITaskGroupService, taskGroupService)
    .register(IRemoteProjectService, remoteProjectService)
// CUA 的两个服务（权限 / PiP）都只注册在 host 侧、且内部按平台与 authority 自行降级：
// 注册始终存在，能力是否存在由 getStatus 返回的 available/reason 表达，UI 因此不需要按平台分支。
    .register(ICuaPermissionService, cuaPermissionService)
    .register(ICuaPipSessionService, cuaPipSessionService)
// 会话发布服务在远端是 Unsupported 实现：注册始终存在，保证 RPC 频道不需要条件暴露，
// 调用方只按返回值处理，不按 Host 形态判断能力。
    .register(IConversationShareService, conversationShareService)
    .register(
// Bot 服务会读写 workspace 绑定并派生后台任务，因此它的 runStartupBackgroundTasks 只在本地权威侧开启：
// 远端 Host 启动期不再轮询旧 Preset，避免重新制造一套模型候选事实。
      IBotsService,
      createBotsService({
        repo: botsRepo,
        projectService,
        remoteProjectService,
        ownerHostId: options?.projectStorageHostId ?? "local",
        credentialService,
        zcodeTaskService,
        broadcastService,
        settingService,
        modelSelectionService: providerRuntime.modelSelection,
        remoteWorkspaceService: botRemoteWorkspaceService
          ? { ...botRemoteWorkspaceService, resolveWorkspace: options?.resolveBotRemoteWorkspace }
          : undefined,
        // 远端与本地 Bot 都读取所属 Environment 的 Model Selection View。
        // 远端启动期不再轮询旧 Preset，避免重新制造一套模型候选事实。
        runStartupBackgroundTasks: !isDesktopAttachedRemote,
      }),
    )
// 文件监听、OAuth、SourceServer workspace 都是「按需启动」的服务：注册即构造，真正的 watcher
// 由 workspace 打开事件拉起，Host 启动不会因为监视大目录而抖动。
    .register(IFileWatcherService, createFileWatcherService())
// OAuth 服务与 zcodeJwtLogoutHandlerRef 双向关联：这里注册后，401 分类与退出登录就走同一条实现。
    .register(IOAuthService, oauthService)
    .register(ISourceServerWorkspaceService, sourceServerWorkspaceService)
    .register(
// 用量统计注入账号鉴权与官方 MCP 凭证解析：两处必须共用同一解析结果，否则统计口径与实际请求身份不一致。
      IUsageStatsService,
      createUsageStatsService({
        apiClient,
        accountRequestAuthService,
        credentialService,
        zcodeAgentService,
        officialMcpCredentialSource,
      }),
    )
// 订阅服务是「账号能做什么」的只读视图来源：闲时任务、动态工作流、加速卡都从这里取能力，
// 它内部会 await providerRuntime.start() 以保证视图基于已就绪的 Registry。
    .register(ICodingPlanSubscriptionService, codingPlanSubscriptionService)
    .register(
      IClientConfigService,
      createClientConfigService({
        apiClient,
        resolveRequestContext: async () => ({
          endpointOrigin: await resolveCurrentZCodeEndpointOrigin(),
          appVersion: ZCODE_VERSION,
          platform: `${process.platform}-${process.arch}`,
        }),
      }),
    )
// 场景与客户端配置共用 apiClient 与端点解析：两者都按 Host 的 endpoint 取远端配置，
// 不允许在构造时固化 origin（用户可能随时改自定义端点）。
    .register(IClientScenesService, createClientScenesService({ apiClient }))
    .register(
// 闲时任务服务的单例属主就是本集合：renderer 经 ProxyChannel 直连，host 派发经 getOptional
// 取到同一个实例；若在此处再 new 一个，两边会各自维护 claim 状态并重复派发。
      IOffPeakTaskService,
      (() => {
        // 闲时任务编排服务（与 automation 服务面独立）：
        // 单例属主在本集合，renderer 经 ProxyChannel 直连，host 派发经 getOptional 取同一实例。
// 闲时任务日志单列 scope：它有自己的 claim/派发状态机，与 Agent 会话日志混在一起时无法定位
// 「任务为什么没跑」。
        const offPeakLogger = createServiceLogger("off-peak");
// 凭据解析保持为闭包而不是快照值：每次调用都重新读当前登录态，避免闲时任务沿用启动时的身份。
        const resolveCredentials = () => resolveOffPeakCredentials(offPeakCredentialResolverDeps);
// origin 解析器参与 mock 分流：resolveOffPeakMockUpstream 只在显式 mock 环境生效，
// 生产下它恒返回 undefined，从而走真实网关。它持有可关闭的资源，随服务 dispose 一起 close。
        const originResolver = createOffPeakOriginResolver({
          logger: offPeakLogger,
          resolveUpstream: () => resolveOffPeakMockUpstream(offPeakCredentialResolverDeps),
        });
// [资源] OffPeakTaskRepo 与 TaskIndexRepo 共用 tasks-index.sqlite 但各自持有连接：必须在 services
// 建好后统一 close，否则 Windows 上悬空句柄会让宿主回收后的目录删除撞 EBUSY（Linux 的
// unlink-while-open 语义会掩盖这个泄漏）。工厂在注册链求值期执行，此时不能引用 services 常量。
        const offPeakTaskRepo = new OffPeakTaskRepo();
        // OffPeakTaskRepo 也持有 tasks-index.sqlite 连接；收集到链前数组，services 建好后统一登记
        // （工厂在注册链求值期执行，此时 services 常量尚未初始化，不能直接引用）
        sqliteReposToClose.push(offPeakTaskRepo);
// [并发] 闲时任务会回调 stopRunningTask/派发，全部经 zcodeTaskService 的接口而不是直接操作 session，
// 保证「停止生成」与用户手动停止走同一条路径（幂等、可观测）。
        const offPeakTaskService = new OffPeakTaskService({
          prepareProjectExecution,
          repo: offPeakTaskRepo,
          client: createOffPeakServerClient({
            resolveOrigin: originResolver.resolveOrigin,
            resolveCredentials,
            logger: offPeakLogger,
          }),
          resolveCodingPlanSupport: () =>
            resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps),
// 遥测里上报的是 provider 主机名而不是完整 URL：只保留主机可避免把自定义端点路径写进数仓。
          resolveTelemetryProviderName: async () =>
            resolveSafeTelemetryHostname(await originResolver.resolveOrigin()),
          resolveModelSelection: async (input) => {
            await providerRuntime.start();
            const support = await resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps);
            const providerId = support.supported
              ? OFF_PEAK_PROVIDER_IDS[support.providerFamily]
              : undefined;
            const provider = providerId
              ? providerRuntime.registryService
                  .getView()
                  .providers.find((candidate) => candidate.providerId === providerId)
              : undefined;
            const modelId = input.modelId ?? provider?.models[0]?.modelId;
            if (!provider || !modelId) {
              return {
                ok: false as const,
                validation: {
                  ok: false as const,
                  code: "provider-not-found" as const,
                  providerId: OFF_PEAK_PROVIDER_IDS.zai,
                },
              };
            }
            // 旧行没有 Provider 身份；只能复用当前账号凭据链已裁定的 Account Family，
            // 不能靠 Registry/JSON 顺序在 Z.ai 与 BigModel 间猜测。
            const selection = {
              providerId: provider.providerId,
              modelId,
              ...(input.reasoningLevel
                ? { options: { reasoningLevel: input.reasoningLevel } }
                : {}),
            };
            const validation = providerRuntime.registryService.validateSelection(selection);
            return validation.ok
              ? { ok: true as const, selection }
              : { ok: false as const, validation };
          },
          logger: offPeakLogger,
          requestSchedulerWake: options?.onOffPeakSchedulerWakeRequested,
          stopRunningTask: async (params) => {
            await zcodeTaskService.stopGeneration({
              taskId: params.conversationId,
              workspacePath: params.workspacePath,
              ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            });
          },
          onDispose: () => {
            void originResolver.close().catch(() => undefined);
          },
        });
// 装配完成后立刻启动同步循环，并在同一处回写前向引用：zcodeAgentService 的 offPeak/create、
// offPeak/list handler 依赖该引用，若先建服务后赋值会有一个窗口内请求拿到 undefined。
        offPeakTaskService.startSync();
        // 回写前向引用，供 zcodeAgentService 的 offPeak/create、offPeak/list 协议 handler 调用。
        offPeakTaskServiceForAgent = offPeakTaskService;
        return offPeakTaskService;
      })(),
    )
    .register(
// 加速卡服务是「网关 + 本地状态」的组合：transport 与鉴权头都在此闭包内构造，
// mock 场景通过 ZCODE_HIGHSPEED_MOCK_SCENARIO 白名单注入，生产不允许任意 scenario 生效。
      IHighspeedCardService,
      (() => {
        const origin = resolveRuntimeZCodeEndpointOrigin(process.env);
        const rawMockScenario = process.env.ZCODE_HIGHSPEED_MOCK_SCENARIO;
        const mockScenarios = new Set<HighspeedMockScenario>([
          "hit-fast",
          "miss",
          "hit-after-timeout",
          "hit-invalid-model",
          "hit-queue-edit",
          "existing-foreign-task-card",
          "expired-card",
        ]);
// [失败路径] 未命中的 scenario 一律视为 null（走真实 transport），不能因为拼错环境变量
// 就静默落到某个 mock 分支：那会让线上把真实扣费请求打成假响应。
        const mockScenario = mockScenarios.has(rawMockScenario as HighspeedMockScenario)
          ? (rawMockScenario as HighspeedMockScenario)
          : null;
// 健康检查只需要 zcode JWT：拿不到就抛错，让调用方明确「未登录」而不是发一个匿名请求换来 401。
        const resolveHighspeedLoginHeaders = async (): Promise<Record<string, string>> => {
          const jwt = (await credentialService.load("zcodejwttoken"))?.trim() ?? "";
          if (!jwt) throw new Error("highspeed request requires zcode jwt");
          return { Authorization: /^Bearer\s/i.test(jwt) ? jwt : `Bearer ${jwt}` };
        };
// [权衡] mock 与真实 transport 在构造期二选一：运行期切换会让已缓存的卡片状态与后端不一致，
// 因此 scenario 只从进程 env 读取一次，不支持热切换（本地验证需重启 Host）。
        const transport = mockScenario
          ? createHighspeedMockTransport({ scenario: mockScenario })
          : createHighspeedHttpTransport({
              drawUrl: `${origin}/api/v1/highspeed/draw`,
              healthyBaseUrl: `${origin}/api/v1/highspeed/`,
              logger: createServiceLogger("highspeed"),
              drawHeaders: async () => {
                const credentials = await resolveOffPeakCredentials(offPeakCredentialResolverDeps, {
                  allowMockCredentials: false,
                });
                const codingPlanAuthorization =
                  (
                    await credentialService.load(`oauth:${credentials.providerFamily}:access_token`)
                  )?.trim() ?? "";
                return buildHighspeedCodingPlanAuthHeaders({
                  zcodeJwt: credentials.jwt,
                  codingPlanAuthorization,
                  targetType:
                    credentials.organizationId && credentials.projectId ? "TEAM" : "PERSONAL",
                  ...(credentials.organizationId
                    ? { organizationId: credentials.organizationId }
                    : {}),
                  ...(credentials.projectId ? { projectId: credentials.projectId } : {}),
                });
              },
              healthyHeaders: resolveHighspeedLoginHeaders,
            });
// 加速卡服务只做编排：draw/推理都经 highspeed transport，鉴权头由上面的闭包现算，
// 保证卡片 token 与账号身份永远是同一代（切换账号后旧卡不再可用）。
        return new HighspeedCardService({
          transport,
          // 普通 mock 只验证抽卡 UI，不依赖隐藏执行 Provider；目录外模型与队列编辑场景
          // 必须走真实 Highspeed execution Selection，才能覆盖创建期退回和队列模型隔离。
          inferenceMode:
            mockScenario &&
            mockScenario !== "hit-invalid-model" &&
            mockScenario !== "hit-queue-edit"
              ? "session-default"
              : "highspeed",
          // 规则 11：draw 只对 Coding Plan 用户开放；mock 场景放行以便本地验证。
// mock 场景放行 Coding Plan 判定，仅为了本地能走通 UI；真实路径必须读账号能力视图。
          resolveCodingPlanSupported: mockScenario
            ? async () => true
            : async () =>
                (await resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps)).supported,
          // 规则 14：会话模型必须属于所选 Coding Plan Provider 的模型目录（Built-in Provider
          // Config 投影）才发起新 draw；mock 场景放行以便本地验证。
          resolveModelCovered: mockScenario
            ? async () => true
            : async (providerId, modelId) => {
                const view = await providerRuntime.modelSelection.getView();
                const provider = view.providers.find((item) => item.providerId === providerId);
                return provider?.models.some((model) => model.modelId === modelId) ?? false;
              },
          // 加速推理与 draw 走同一 highspeed 网关、同一 Coding Plan 双 JWT 契约：必须携带
          // zcode JWT + Coding Plan 业务 JWT + Team 身份头。此前只发 zcode JWT + 卡 ID，网关
          // 无法校验 Coding Plan 权益，返回 401 auth_failed。与 draw 头复用同一次 selected
          // connection 解析，避免把 ZAI 身份的卡打到 BigModel 加速 Provider。
// 推理与 draw 走同一网关、同一双 JWT 契约：只发 zcode JWT 会被网关判为未校验 Coding Plan 权益，
// 直接返回 401 auth_failed。Team 身份头按 organizationId+projectId 同时存在才添加。
          resolveInferenceAuth: async () => {
            const credentials = await resolveOffPeakCredentials(offPeakCredentialResolverDeps, {
              allowMockCredentials: false,
            });
            const codingPlanAuthorization =
              (
                await credentialService.load(`oauth:${credentials.providerFamily}:access_token`)
              )?.trim() ?? "";
            return {
              zcodeJwt: credentials.jwt,
              family: credentials.providerFamily,
              codingPlanAuthorization,
              targetType: credentials.organizationId && credentials.projectId ? "TEAM" : "PERSONAL",
              ...(credentials.organizationId ? { organizationId: credentials.organizationId } : {}),
              ...(credentials.projectId ? { projectId: credentials.projectId } : {}),
            };
          },
        });
      })(),
    )
// Skill / 同步 / 插件类服务都以 workspace 为单位枚举本地文件，注册即构造但不做扫描，
// 扫描发生在对应请求到达时（避免 Host 启动时遍历所有 workspace 目录）。
    .register(ISkillsService, skillsService)
    .register(ISkillSyncService, createSkillSyncService())
    .register(IMcpSyncService, mcpSyncService)
    .register(
// GenUI 服务需要 registerSandbox 才能渲染插件提供的 UI：缺失时服务仍注册，但沙箱类能力不可用。
      IGenUiService,
      createGenUiService({ registerSandbox: options?.registerPluginSandbox }),
    )
    .register(IPluginUiBridgeService, pluginUiBridgeService)
    .register(IPluginUiSamplingService, pluginUiSamplingService)
    .register(IPluginUiAppToolsService, pluginUiAppToolsService)
    // 合并 MCP/Plugin Management 服务装配时误删了 plugin-sync 注册，
    // RemoteServiceAccess 仍会请求该频道，导致本地候选枚举超时、远端同步无法开始。
    .register(IPluginSyncService, pluginSyncService)
    .register(IPluginsService, createPluginsService({ isDesktopRuntime: true }))
    // 设置页插件管理薄服务——plugins/* 旧协议词的 host 侧唯一消费点。
    .register(
      IPluginManagementService,
      createPluginManagementService({
        zcodeAgentService,
        reportTelemetryEvent: options?.reportPluginTelemetryEvent,
      }),
    )
// 子 Agent 服务在注册前就已构造：Agent 服务在 spawn 时需要 prepareRuntimeState，
// 因此它必须早于 Agent 服务的依赖闭包被创建（见 resolveSpawnEnv 中的调用）。
    .register(ISubagentsService, subagentsService)
    .register(ICommandsService, createCommandsService({ isDesktopRuntime: true }))
    .register(
      IHooksService,
      createHooksService({
        grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
      }),
    )
// 记忆 / 输出风格 / 设置同步都是无状态投影：注册的是工厂产物，不参与 dispose 链，
// 因此不会出现在 disposeServiceResources 的服务列表里。
    .register(IMemoryService, createMemoryService())
    .register(IOutputStyleService, createOutputStyleService())
// 设置同步注入的是同一个 settingService 实例：它只读取与对齐，不自己写设置，
// 保证「谁写入、谁广播」始终只有一份语义。
    .register(ISettingsSyncService, createSettingsSyncService({ settingService }))
    .register(
// 反馈服务合并注入的反馈配置与共享 apiClient/credential/oauth：注入项只覆盖 API 选项，
// 不允许替换鉴权链，否则反馈会以错误身份提交。
      IFeedbackService,
      createFeedbackService({
        ...options?.feedback,
        apiClient,
        credentialService,
        oauthService,
      }),
    )
    .register(IPromptAttachmentTransferService, createLocalPromptAttachmentTransferService());

  // 即使初始配置关闭也必须登记 lifecycle disposer：terminal fence 需要早于任意延迟 setting/acquire
  // 恢复，不能把"当前还没有 Helper"误当成"不需要生命周期所有者"。dispose 时串行 stop host。
// [资源] 即使初始配置关闭也必须登记 disposer：terminal fence 要求 Stop 早于任何延迟的 setting/acquire
// 恢复，不能把「当前还没有 Helper」当成「不需要生命周期所有者」。dispose 时串行 stop 托管 host。
  registerManagedCuaHelperHostForDispose(services, {
    stop: async () => {
      await defaultCuaProductHelperLifecycle.dispose();
    },
  });
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);
  // disposer 注册完成后才排预热。若 createLocalServices 中途抛错，不能留下一个无人持有、却会在当前
  // 调用栈结束后才创建的高权限 Helper；若返回后立即 dispose，terminal fence 会先于 acquire 生效。
  // Helper 懒启动：不预热——Helper 由 SDK 首次 CUA 调用拉起（spawn env 注入
  // 稳定 socket），或用户显式授权流（restartHelper）拉起。启动即零 Helper 常驻。

// [并发] 以下 WeakMap 写入是「发布点」：写入之后，同进程的 Agent 适配层才可取用这些私有能力。
// 放在注册链之后而不是之前，保证取用时服务集合已完整（消费方可能顺带读其它服务）。
  accountRequestAuthServices.set(services, accountRequestAuthService);
  offPeakRequestAuthBuilders.set(services, buildOffPeakRequestAuthForTicket);

  providerRuntimes.set(services, providerRuntime);
  providerProvisioningSources.set(services, providerProvisioningSource);
  providerProvisioningTriggerDisposers.set(services, providerProvisioningDisposers);
  // desktop-attached-remote 的组织态在远端 Host 库里，由远端自己的扫描器归档；本机不扫。
  if (!isDesktopAttachedRemote) {
// 自动归档只由本文件托管：设置变更按 shouldRescanTaskAutoArchive 判定是否需要补扫，
// 补扫失败被吞掉（下一次定时扫描会再试），避免一次设置写入被归档错误放大成 UI 报错。
    const stopSettingsRescan = settingService.onDidUpdate((event) => {
      if (shouldRescanTaskAutoArchive(event.keys)) {
        void taskAutoArchiveScheduler.scan().catch(() => {});
      }
    });
    taskAutoArchiveScheduler.start();
    taskAutoArchiveDisposers.set(services, () => {
      stopSettingsRescan();
      taskAutoArchiveScheduler.dispose();
    });
  }
  services
    .register(IProviderSettingsService, providerRuntime.providerSettings)
// Provider 设置与模型选择两个接口都直接暴露 runtime 的内部服务实例：
// 它们是同一份 Registry 视图的两个切面，分开注册只是为了让消费方依赖更窄的接口。
    .register(IModelSelectionService, providerRuntime.modelSelection);
  if (isDesktopAttachedRemote || options.providerProvisioningTargetEnabled === true) {
    services.register(
// [安全边界] Provisioning target 只在调用方明确开启认证（或远端 attachment）时注册：
// 默认不暴露，避免无意中把本 Environment 的凭据开放给外部调用方。
      IProviderProvisioningTargetService,
      createProviderProvisioningTarget({
        providerRuntime,
        personalRepository: providerConfigRuntime.personalRepository,
        accountProviderSource: accountProviderConfigSource,
        credentialService,
        settingService,
        personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        stateFilePath: join(resolveAppConfigDir(), "runtime", "provider", "provisioning.json"),
        listProvisioningCredentialKeys: () =>
          listProviderProvisioningCredentialKeys(resolveCredentialFilePath(resolveAppConfigDir())),
      }),
    );
  }
  const log = createServiceLogger("provider-runtime");
// [事务] 启动期预热 Provider Registry 但不阻塞返回：成功只记一条 info（配置版本 + provider 数），
// 失败记 error 而不抛出——Host 必须能起来，模型不可用由各请求路径各自降级并报错。
  void providerRuntime.start().then(
    () => {
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      log.info("Provider Registry 已就绪", {
        configRevision: snapshot.sourceRevisions.config,
        providerCount: snapshot.registry.providers.length,
      });
    },
    (error: unknown) => {
      log.error("Provider 配置事实初始化失败", error);
    },
  );

  // 见 sharedSqliteRepos 声明处注释：登记全部 tasks-index sqlite 句柄，dispose 链统一关闭
// TaskIndexRepo 最后入列：注册链里创建的其余 repo（OffPeak 等）已在前面 push，顺序不影响 close，
// 但统一在同一处写入 WeakMap 可以保证「收集完才发布」，中途抛错不会留下半张登记表。
  sqliteReposToClose.push(taskIndexRepo);
  sharedSqliteRepos.set(services, sqliteReposToClose);
  return services;
}

// 遥测 userId 是只读上报入口：凭据解密失败不清理、不重试，只 warn 后返回空串。
// 若在这里做「半套 logout」，会抢在 host OAuthService 之前清掉会话，漏掉派生模型 provider key 的收口。
export function createTelemetryUserIdLoader(
  credentialService: Pick<ICredentialService, "load">,
): () => Promise<string> {
  const log = createServiceLogger("telemetry-user-id");
  return async () => {
    try {
      const activeProvider = (await credentialService.load("oauth:active_provider"))?.trim() ?? "";
      if (!activeProvider) {
        return "";
      }

      const rawUserInfo = await credentialService.load(`oauth:${activeProvider}:user_info`);
      return readTelemetryOAuthUserId(rawUserInfo);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      // Bugfix: telemetry 只是只读 userId 上报入口，不能抢在 host OAuthService 前
      // 对损坏凭据做半套清理；否则会漏掉派生模型 provider key 的 logout 收口。
      log.warn(undefined, "skip telemetry user id: OAuth credential decrypt failed", error);
      return "";
    }
  };
}

/** 仅给同一事件账号返回当前 ZCode JWT；不缓存、不修改登录凭据。 */
// [并发] 授权头只在「事件账号仍然就是当前账号」时返回：读取期间可能发生退出或切号，
// 因此拿到 JWT 后要再确认一次 active_provider 与 user_info 未变，否则旧 token 会被贴到别人的事件上。
// 只接受 zai/bigmodel 两家，且 JWT 必须是可打印 ASCII（防止换行注入）。
export function createTelemetryAuthorizationLoader(
  credentialService: Pick<ICredentialService, "load">,
): (userId: string) => Promise<string | null> {
  return async (userId) => {
    if (!userId) return null;
    try {
      const provider = (await credentialService.load("oauth:active_provider"))?.trim();
      if (provider !== "zai" && provider !== "bigmodel") return null;
      const readUserId = async () =>
        readTelemetryOAuthUserId(await credentialService.load(`oauth:${provider}:user_info`));
      if ((await readUserId()) !== userId) return null;
      const jwt = (await credentialService.load("zcodejwttoken"))?.trim();
      // 退出/切账号可能发生在异步读取期间；禁止将旧身份的 token 附到其他账号事件上。
      if (
        (await credentialService.load("oauth:active_provider"))?.trim() !== provider ||
        (await readUserId()) !== userId
      )
        return null;
      return jwt && /^[\x21-\x7e]+$/.test(jwt) ? `Bearer ${jwt}` : null;
    } catch {
      return null;
    }
  };
}

// 渠道归因直接读 OAuth 的同一份事实：早期实现固定返回 null，导致数仓丢失已保存的投放来源。
export function createTelemetryMarketingParamsLoader(
  credentialService: ICredentialService,
): () => Promise<import("@zcode/shared").OAuthLoginAttribution | null> {
  // 恢复原因：固定返回 null 会丢掉已保存的渠道归因，数仓应读取 OAuth 的同一份事实。
  const repo = new OAuthCredentialRepo(credentialService);
  return () => repo.loadLoginAttribution();
}

// [失败路径] user_info 是外部写入的 JSON，解析失败返回空串而不是抛错：遥测投递不能因为
// 一条脏数据中断整批事件；id 与 user_id 两种键名都认，优先 id。
function readTelemetryOAuthUserId(rawUserInfo: string | null): string {
  if (!rawUserInfo) {
    return "";
  }

  try {
    const parsed = JSON.parse(rawUserInfo) as {
      id?: unknown;
      user_id?: unknown;
    };
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
    return id.trim() || userId.trim();
  } catch {
    return "";
  }
}

// [资源] 同步释放路径只用于「进程即将退出」的兜底：能同步停的先停，必须 await 的（Agent 进程树、
// Helper）只发起不等待。顺序固定为：可释放服务 → CUA Helper → sqlite 句柄 → provider runtime →
// provisioning 订阅 → 归档定时器 → 网络 transport。
// 反序（先关句柄再停服务）会让服务在关闭过程中写已关闭的连接，异常被吞后表现为数据丢失。
export function disposeServiceResources(services: ServiceCollection): void {
  const content = services.getOptional(ICloudContentService);
  if (content && hasDisposeAllAndWait(content)) void content.disposeAllAndWait().catch(() => {});
  (
    services.getOptional(IGenUiService) as (IGenUiService & { dispose?(): void }) | undefined
  )?.dispose?.();
  // Bugfix: host process 退出前以前没有统一遍历本地服务做资源回收，
  // terminal/task wrapper 这类会拉起子进程的服务只能等宿主进程自己结束，时序上可能留下短暂残留。
  // 这里集中调用各服务的本地 disposeAll 钩子，把“退出 app = 回收所有托管资源”落成机械动作。
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(ISubagentsService),
    services.getOptional(IOffPeakTaskService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 同步 best-effort：终止托管的 Computer Use Helper（不 await，避免阻断同步 dispose 路径）。
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    void managedCuaHelperHost.stop().catch(() => {});
  }
  // 关闭共享 tasks-index sqlite 句柄（Windows 上悬着句柄会让后续目录清理撞 EBUSY）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  taskAutoArchiveDisposers.get(services)?.();
  taskAutoArchiveDisposers.delete(services);
  managedHostApiNetworkTransports.get(services)?.dispose();
}

// [资源] 异步释放路径是 app 正常关闭使用的版本：必须等待 Agent 进程树 graceful + force 完成，
// 旧的纯同步 dispose 会丢掉强杀 timer，导致 zcode-cli / app-server 变成孤儿进程。
// 与同步版的差异只在「等待」：服务列表、Helper、sqlite、侧表的处理顺序刻意保持一致，防止两条路径
// 出现不同的泄漏画像（排查时只需看一份顺序）。
export async function disposeServiceResourcesAndWait(services: ServiceCollection): Promise<void> {
  (
    services.getOptional(IGenUiService) as (IGenUiService & { dispose?(): void }) | undefined
  )?.dispose?.();
  // app 关闭时 host 需要等 agent 进程树完成 graceful + force 清理。
  // 旧的同步 dispose 会在 host 退出时丢掉强杀 timer，导致 zcode-cli/app-server 变成孤儿进程。
  const disposableServices = [
    services.getOptional(ICloudContentService),
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(ISubagentsService),
    services.getOptional(IOffPeakTaskService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAllAndWait(service)) {
      await service.disposeAllAndWait();
    } else if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 等待托管的 Computer Use Helper 终止（best-effort）：Helper 是长生命周期高权限进程，服务释放语义必须显式
  // 收口它，不能只靠 launcher-pid watchdog / 进程退出兜底。
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    await managedCuaHelperHost.stop().catch(() => {});
  }
  // 关闭共享 tasks-index sqlite 句柄（同 disposeServiceResources，异步收口路径也要释放）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  taskAutoArchiveDisposers.get(services)?.();
  taskAutoArchiveDisposers.delete(services);
  await managedHostApiNetworkTransports
    .get(services)
    ?.disposeAndWait()
    .catch(() => {});
}

/** 所有应用入口在开放 RPC / 调度器前等待；失败不启动业务写者。 */
// [事务] 迁移屏障：所有入口在开放 RPC / 启动调度器之前 await 本函数。三个库各自 ensureReady，
// 任一失败就不启动业务写者（避免半迁移状态被写入放大）。finally 里逐个 close：即使迁移抛错也要
// 释放句柄，否则同一进程重试时会命中「数据库被占用」。
export async function migrateApplicationStorage(
  settings?: Pick<AppSettings, "lastWorkspaceSession" | "recentProjects">,
  hostId?: string,
): Promise<{ backupSkipped: boolean }> {
  const automations = new AutomationRepo();
  const offPeak = new OffPeakTaskRepo();
  const tasks = new TaskIndexRepo(settings, hostId);
  try {
    await automations.ensureReady();
    await offPeak.ensureReady();
    await tasks.ensureReady();
    return {
      backupSkipped:
        tasks.migrationBackupSkipped ||
        automations.migrationBackupSkipped ||
        offPeak.migrationBackupSkipped,
    };
  } finally {
    tasks.close();
    offPeak.close();
    automations.close();
  }
}

export { bindRemoteProjectIdentities } from "#src/project/index.js";

export { startupStorage } from "#src/startup-storage/index.js";

/** 独立 Server 共用迁移屏障与身份装配；入口不得以 local owner 开放远端项目 RPC。 */
// 独立 Server 复用同一套迁移屏障与身份装配，但固定 serviceAuthorityMode=standalone-server：
// 它绝不以 local owner 开放远端项目 RPC，也不创建默认 CUA Helper（见 shouldCreateDefaultCuaProductHelper）。
// projectStorageHostId 由 serverId + 根路径派生，派生失败直接抛错——用一个猜出来的 hostId 建库，
// 会让后续真正的 Host 连到「空库」并覆盖已有目录。
export async function createServerHostServices(options: {
  topicResourceRelayChannel?: NonNullable<
    Parameters<typeof createLocalServices>[0]
  >["topicResourceRelayChannel"];
  sourceServerId: string;
  zcodeBuiltinProviderConfigFilePath: string;
  providerProvisioningTargetEnabled?: boolean;
}) {
  const projectStorageHostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId: options.sourceServerId, workspacePath: "/" }),
  );
  if (!projectStorageHostId) throw new Error("Invalid Source Server storage identity");
  await migrateApplicationStorage(await createSettingService().get(), projectStorageHostId);
// [事务] 身份别名库记录「路径 → 稳定身份」的历史映射，迁移失败数在服务启动前读取一次，
// 供调用方决定是否需要提示用户；读取发生在 createLocalServices 之前，避免迁移与装配互相等待。
  const workspaceAliasRepo = new SourceServerWorkspaceAliasRepo();
// mapper 必须与 alias repo 成对构造并注入同一个服务：两个 mapper 会让同一路径解析出两个身份，
// 表现是同一 workspace 的会话被拆成两条互不可见的记录。
  const workspaceIdentityMapper = new SourceServerWorkspaceIdentityMapper();
  const sourceServerWorkspaceService = createSourceServerWorkspaceService(workspaceAliasRepo, {
    defaultWorkspaceIdentity: (workspacePath) =>
      buildServerRemoteWorkspaceIdentity({ serverId: options.sourceServerId, workspacePath }),
    onResolved: ({ workspacePath, canonicalWorkspaceKey }) => {
      workspaceIdentityMapper.register({
        stableIdentity: buildServerRemoteWorkspaceIdentity({
          serverId: options.sourceServerId,
          workspacePath,
        }),
        canonicalIdentity: canonicalWorkspaceKey,
      });
    },
  });
  const migrationFailedPathCount = await workspaceAliasRepo.getFailedPathCount();
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath: options.zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: options.providerProvisioningTargetEnabled,
    serviceAuthorityMode: "standalone-server",
    topicResourceRelayChannel: options.topicResourceRelayChannel,
    projectStorageHostId,
    sourceServerWorkspaceService,
  });
  return { services, workspaceIdentityMapper, migrationFailedPathCount };
}

export { scopeConversationShareServiceForAttachment } from "./conversation-share/conversationShareConnectionScope.js";
export { localRuntimeNetworkCapture } from "./zcode-agent/localRuntimeNetworkCapture.js";
