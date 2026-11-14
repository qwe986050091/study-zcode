// INV-01 注册清单与合同逐项一致：守住位置 自检；改错故障 合同声明支持却报未知通道。
// INV-02 合同校验最先执行：守住位置 函数首行；改错故障 装配到一半才失败。
// INV-03 缺项整体抛错：守住位置 自检末尾；改错故障 返回半套服务面难以定位。
// INV-04 远端面只做转发：守住位置 注册表；改错故障 本地实现悄悄顶替远端能力。
// INV-05 本机配置单独注入：守住位置 客户端配置项；改错故障 远端覆盖本机私有设置。
// INV-06 分享能力按目标类型：守住位置 三元分支；改错故障 不支持的场景给出假实现。
// INV-07 虚拟项目要求双服务：守住位置 virtualProjects 分支；改错故障 缺项时静默降级。
// INV-08 新频道以握手为准：守住位置 注释与校验；改错故障 用对象存在性判断旧服务端能力。
// INV-09 广播按通道分流：守住位置 包装实现；改错故障 任务组消息被误发到远端。
// INV-10 分流依赖两端都在：守住位置 条件判断；改错故障 单侧缺失时丢订阅。
// INV-11 订阅返回合并句柄：守住位置 onMessage；改错故障 退订只退一侧留下泄漏。
// INV-12 领用类操作全部下沉：守住位置 转发方法；改错故障 本地领用状态与远端分叉。
// INV-13 单根项目按 hostId 过滤：守住位置 过滤；改错故障 混入其他服务端工作区。
// INV-14 兼容旧工作区字段：守住位置 分支；改错故障 老数据目录从列表消失。
// INV-15 任务查询按种类分派：守住位置 三元链；改错故障 置顶与归档视图互相串数据。
// INV-16 配置下发单向：守住位置 Provisioning；改错故障 远端反向改写本机 Provider。
// INV-17 副作用限定注入范围：守住位置 装配末尾；改错故障 全局执行器被多处复用。
// INV-18 诊断日志按服务分域：守住位置 日志器构造；改错故障 日志无法按能力过滤。
//
// 模块职责：把远端 RPC 服务面装配为 Host 本地可用的服务集合。
// 状态所有权：函数式装配；集合与执行器都由本次调用创建。
// 阅读顺序：先看注册清单，再看项目服务适配，最后看集合装配与自检。
// Server remote workspace 的 Host 服务集合装配器：把「远端 server 提供的 RPC 服务面」包装成
// Host 本地的 ServiceCollection，供 desktop attachment 按 clientMode/scopes 暴露。
//
// 边界：本文件不做协议传输（由 connectServerRemote* 负责），也不决定暴露哪些服务
// （由 windowHostAttachmentRpcPolicy 负责）；它只做「逐项转发 + 补齐 Host 侧专有服务」。
// 关键不变量：注册集合必须与 REMOTE_WORKSPACE_RPC_CHANNELS 合同逐项一致，缺失即整体抛错，
// 避免出现「合同声明支持、运行时 Unknown channel」的半套服务面；所有转发项都取自
// connectionServices（远端），Host 私有的 clientConfigService 与 Provisioning executor 单独注入。
// 失败语义：合同校验最先执行（assertRemoteWorkspaceRpcContract），装配完成后再做一次
// 完整性自检，任一缺失都不会返回部分可用的 collection。
// 注意：本文件不参与 #18 的 attachment 账本，但它的产物是 remote attachment 的服务面来源，
// 因此注册项缺失会直接表现为手机侧 attach 后调用失败。

import {
  ServiceCollection,
  IFileService,
  IGenUiService,
  IMediaPreviewService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  IOnboardingRecordService,
  ICredentialService,
  IBroadcastService,
  IZCodeTaskService,
  IZCodeAgentService,
  IZCodeSessionService,
  IConversationShareService,
  createUnsupportedConversationShareService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IModelSelectionService,
  IProviderSettingsService,
  ISourceServerWorkspaceService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  IOutputStyleService,
  ISettingsSyncService,
  IProjectService,
  ITaskGroupService,
  IRemoteProjectService,
  IPromptAttachmentTransferService,
  type ServiceDescriptor,
  type IServiceAccessor,
} from "@zcode/services";
import {
  REMOTE_WORKSPACE_RPC_CHANNELS,
  assertRemoteWorkspaceRpcContract,
} from "./remoteWorkspaceRpcContract.js";
import {
  createServiceLogger,
  createLegacySingleRootProjectService,
  createRemoteProjectService,
} from "@zcode/services/node";
import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import type { RemoteTarget } from "@zcode/shared";
import {
  createRemoteProviderProvisioningExecutorFromWorkspace,
  registerRemoteProviderProvisioningExecutor,
} from "./remoteProviderProvisioningService.js";

// 远端 workspace 的 RPC 注册清单（accessor key -> ServiceDescriptor），也是完整性自检的依据。
// 顺序只影响日志/诊断可读性，不影响解析；新增服务时必须同时在 remoteWorkspaceRpcContract
// 的 channel 合同里登记，否则 createServerRemoteWorkspaceServiceCollection 会拒绝装配。
// 每项是 keyof IServiceAccessor 与 ServiceDescriptor 的配对。
// 数组顺序只影响日志与诊断可读性，不影响 RPC 解析。
// 新增项必须同步登记 remoteWorkspaceRpcContract 的 channel 合同。
// REMOTE_WORKSPACE_RPC_REGISTRATIONS 同时作为完整性自检依据。
// as const satisfies 断言保证键类型收敛到 IServiceAccessor。
export const REMOTE_WORKSPACE_RPC_REGISTRATIONS = [
  ["fileService", IFileService],
  ["genUiService", IGenUiService],
  ["mediaPreviewService", IMediaPreviewService],
  ["gitService", IGitService],
  ["gitCheckpointService", IGitCheckpointService],
  ["systemService", ISystemService],
  ["terminalService", ITerminalService],
  ["settingService", ISettingService],
  ["onboardingRecordService", IOnboardingRecordService],
  ["credentialService", ICredentialService],
  ["broadcastService", IBroadcastService],
  ["zcodeTaskService", IZCodeTaskService],
  ["zcodeAgentService", IZCodeAgentService],
  ["zcodeSessionService", IZCodeSessionService],
  ["conversationShareService", IConversationShareService],
  ["botsService", IBotsService],
  ["fileWatcherService", IFileWatcherService],
  ["oauthService", IOAuthService],
  ["providerSettingsService", IProviderSettingsService],
  ["modelSelectionService", IModelSelectionService],
  ["sourceServerWorkspaceService", ISourceServerWorkspaceService],
  ["usageStatsService", IUsageStatsService],
  ["codingPlanSubscriptionService", ICodingPlanSubscriptionService],
  ["clientScenesService", IClientScenesService],
  ["skillsService", ISkillsService],
  ["skillSyncService", ISkillSyncService],
  ["mcpSyncService", IMcpSyncService],
  ["pluginSyncService", IPluginSyncService],
  ["pluginsService", IPluginsService],
  ["pluginManagementService", IPluginManagementService],
  ["subagentsService", ISubagentsService],
  ["commandsService", ICommandsService],
  ["hooksService", IHooksService],
  ["memoryService", IMemoryService],
  ["outputStyleService", IOutputStyleService],
  ["settingsSyncService", ISettingsSyncService],
  ["promptAttachmentTransferService", IPromptAttachmentTransferService],
] as const satisfies readonly [keyof IServiceAccessor, ServiceDescriptor<unknown>][];

const conversationShareLog = createServiceLogger("conversation-share");

function createUnsupportedRemoteConversationShareService(): IConversationShareService {
  return createUnsupportedConversationShareService({
    message: "Conversation sharing is not available for this client or remote target",
    onRejected: (action) => {
      conversationShareLog.warn(undefined, "conversation share action rejected", {
        action,
        kind: "feature_disabled",
        reason: "server_remote_unsupported",
      });
    },
  });
}

// 为「非虚拟项目」的 server remote 构造单根 IProjectService。
// 输入：connectionServices（远端 RPC 面）、serverId、virtualProjects、sourceServices（本机 Local Host）。
// 输出：一个把 project 查询映射到远端 system/file/zcodeTask 服务的适配器。
// 失败语义：virtualProjects 分支要求远端已提供 projectService，否则立即抛错（避免静默降级）；
//   readKnownWorkspaces 时 sourceServices/IRemoteProjectService 缺失则返回空目录，不抛错。
// 副作用：只读远端（list 目录/读设置/列任务/ensure 会话目录），不写本机状态。
// 口径：hostId 由 serverId + 根路径 "/" 推导，known workspace 只保留同 hostId 的条目，
//   防止把其它 server 的 workspace 混进当前项目列表。
export function resolveServerProjectService(params: {
  connectionServices: IServiceAccessor;
  serverId: string;
  virtualProjects?: boolean;
  sourceServices?: ServiceCollection;
// params.virtualProjects 为真时直接复用 connectionServices.projectService。
// projectService 缺失时立即抛出 Error，不静默降级。
// 单根项目的 hostId 由标识推导。
// 目录与设置读取全部下沉远端。
// 已知工作区按 hostId 过滤后展开。
}): IProjectService {
  if (params.virtualProjects) {
    if (!params.connectionServices.projectService)
      throw new Error("Remote virtual-project RPC registration incomplete");
    return params.connectionServices.projectService;
  }
  const hostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId: params.serverId, workspacePath: "/" }),
  )!;
  return createLegacySingleRootProjectService({
    hostId,
    directories: {
      info: () => params.connectionServices.systemService.info(),
      read: (input) => params.connectionServices.fileService.readdir(input),
    },
    readSettings: () => params.connectionServices.settingService.get(),
    readKnownWorkspaces: async () => {
      const directory = await params.sourceServices
        ?.getOptional(IRemoteProjectService)
        ?.readDirectory();
      return (directory?.entries ?? [])
        .filter((entry) => entry.hostId === hostId)
        .flatMap((entry) =>
          entry.roots.length
            ? entry.roots.map((root) => ({ workspacePath: root.rootPath }))
            : entry.legacyWorkspace
              ? [
                  {
                    workspacePath: entry.legacyWorkspace.workspacePath,
                    workspacePurpose: entry.legacyWorkspace.workspacePurpose,
                  },
                ]
              : [],
        );
    },
    readTasks: ({ workspacePath, kind }) => {
      const tasks = params.connectionServices.zcodeTaskService;
      const scope = { workspacePath };
      return kind === "pinned"
        ? tasks.listPinnedTasks(scope)
        : kind === "archived"
          ? tasks.listArchivedTasks(scope)
          : tasks.listTasks(scope);
    },
    ensureConversation: async () =>
      (await params.connectionServices.fileService.ensureConversationWorkspace()).path,
  });
}

// 装配 server remote 的完整 Host 服务集合。
//
// 输入：clientConfigService（Host 私有配置，不来自远端）、connectionServices（远端 RPC 面，
//   必须先通过 assertRemoteWorkspaceRpcContract）、targetKind（server / ssh 等，决定分享能力是否可用）、
//   virtualProjects（远端是否提供 project/remoteProject 服务）、sourceServices（本机 Local Host，
//   用于 task-groups 控制面与 Provider Provisioning）。
// 输出：已注册且已自检的 ServiceCollection；它随后由 attachment 层包装成窗口服务面。
// 副作用：创建并注册 Provider Provisioning executor（绑定本机 source 与远端 workspace）；
//   task-groups 场景会把 IBroadcastService 替换为「本地控制面 + 远端数据面」的合流实现。
// 失败语义：合同不完整、virtualProjects 缺项、最终自检缺项都直接抛错，不返回半套集合。
// 不变量：客户端侧总有 proxy 对象，因此「对象存在」不能当作远端能力判断依据——
//   新频道必须以 host capability 握手结果为准（见 virtualProjects 分支的显式校验）。
export function createServerRemoteWorkspaceServiceCollection(params: {
  clientConfigService: IClientConfigService;
  connectionServices: IServiceAccessor;
  virtualProjects?: boolean;
  serverId?: string;
  targetKind: RemoteTarget["kind"];
  /** 本机 Local Host 服务；提供 Provider Provisioning Source，缺失时 Provisioning 按 unsupported 处理。 */
  sourceServices?: ServiceCollection;
// 首行先调用 assertRemoteWorkspaceRpcContract 校验合同。
// remoteProviderProvisioningExecutor 在 ServiceCollection 装配前创建。
// 其余通道按 REMOTE_WORKSPACE_RPC_REGISTRATIONS 清单逐项注册。
// virtualProjects 分支要求 projectService 与 remoteProjectService 齐备。
// 完整性自检在注入 remoteProviderProvisioningExecutor 之前完成。
}): ServiceCollection {
  assertRemoteWorkspaceRpcContract(params.connectionServices);
  // Server remote 连接的是一个已经运行的完整 ZCode server。
  // Host 只做 RPC 转接，不替 server 决定 workspace/runtime/provider 归属；
  // Provider 配置只经 Host 私有的 Provisioning executor 从本机单向下发到远端。
  const remoteProviderProvisioningExecutor =
    createRemoteProviderProvisioningExecutorFromWorkspace(params);
  const services = new ServiceCollection()
    .register(IFileService, params.connectionServices.fileService)
    // 根因：客户端已有 gen-ui 代理，但 Host 漏转发使远端读取成为 Unknown channel。
    // 复用 Source 的读取与输出目录校验；桌面状态/沙箱仍由 base services 提供。
    .register(IGenUiService, params.connectionServices.genUiService)
    .register(IMediaPreviewService, params.connectionServices.mediaPreviewService)
    .register(IGitService, params.connectionServices.gitService)
    .register(IGitCheckpointService, params.connectionServices.gitCheckpointService)
    .register(ISystemService, params.connectionServices.systemService)
    .register(ITerminalService, params.connectionServices.terminalService)
    .register(ISettingService, params.connectionServices.settingService)
    // Bug 原因：远程集合曾漏注册此通道，手机重建 Root 后调用失败，回退 settings 判定而误弹引导。
    // 引导记录必须与该入口的 settings/OAuth 同源：R3 下四种 transport 都由 Source 持有，不借用本机记录。
    .register(IOnboardingRecordService, params.connectionServices.onboardingRecordService)
    .register(ICredentialService, params.connectionServices.credentialService)
    .register(IBroadcastService, params.connectionServices.broadcastService)
    .register(IZCodeTaskService, params.connectionServices.zcodeTaskService)
    .register(IZCodeAgentService, params.connectionServices.zcodeAgentService)
    .register(IZCodeSessionService, params.connectionServices.zcodeSessionService)
    // R3 的分享属于目标 Environment；不能恢复旧 SSH 的本机 JWT 混装。
    .register(
      IConversationShareService,
      params.targetKind === "server"
        ? createUnsupportedRemoteConversationShareService()
        : params.connectionServices.conversationShareService,
    )
    .register(IBotsService, params.connectionServices.botsService)
    .register(IFileWatcherService, params.connectionServices.fileWatcherService)
    .register(IOAuthService, params.connectionServices.oauthService)
    .register(IProviderSettingsService, params.connectionServices.providerSettingsService)
    .register(IModelSelectionService, params.connectionServices.modelSelectionService)
    .register(ISourceServerWorkspaceService, params.connectionServices.sourceServerWorkspaceService)
    .register(IUsageStatsService, params.connectionServices.usageStatsService)
    .register(
      ICodingPlanSubscriptionService,
      params.connectionServices.codingPlanSubscriptionService,
    )
    .register(IClientConfigService, params.clientConfigService)
    .register(IClientScenesService, params.connectionServices.clientScenesService)
    .register(ISkillsService, params.connectionServices.skillsService)
    .register(ISkillSyncService, params.connectionServices.skillSyncService)
    .register(IMcpSyncService, params.connectionServices.mcpSyncService)
    // Bug 原因：RPC 合同已经要求 plugin-sync，但旧全转发集合漏注册，远端插件同步会在 Host
    // 二次暴露时变成 Unknown channel。全转发集合必须与合同逐项一致。
    .register(IPluginSyncService, params.connectionServices.pluginSyncService)
    .register(IPluginsService, params.connectionServices.pluginsService)
    .register(IPluginManagementService, params.connectionServices.pluginManagementService)
    .register(ISubagentsService, params.connectionServices.subagentsService)
    .register(ICommandsService, params.connectionServices.commandsService)
    .register(IHooksService, params.connectionServices.hooksService)
    .register(IMemoryService, params.connectionServices.memoryService)
    .register(IOutputStyleService, params.connectionServices.outputStyleService)
    .register(ISettingsSyncService, params.connectionServices.settingsSyncService)
    .register(
      IPromptAttachmentTransferService,
      params.connectionServices.promptAttachmentTransferService,
    );
  // 新频道必须以握手能力为准；客户端总能生成 proxy，不能用对象存在性判断旧 Server 支持。
  if (params.virtualProjects) {
    if (
      !params.connectionServices.projectService ||
      !params.connectionServices.remoteProjectService
    )
      throw new Error("Remote virtual-project RPC registration incomplete");
    services.register(IProjectService, params.connectionServices.projectService);
    services.register(IRemoteProjectService, params.connectionServices.remoteProjectService);
  } else if (params.serverId) {
    services.register(
      IProjectService,
      resolveServerProjectService({ ...params, serverId: params.serverId }),
    );
    services.register(
      IRemoteProjectService,
      createRemoteProjectService({
        controller: false,
        database: async () => {
          throw new Error("remote-project.controller-only");
        },
      }),
    );
  }
  // task-groups 的状态通道属于本机控制面（它由 Host 维护），其它 channel 仍走远端广播；
  // 因此只在两端都可用时做分流，避免把控制面消息误发到远端或丢失本地订阅。
  // controllerGroups 与 controllerBroadcast 取自 sourceServices 本机来源。
  // 两端都存在才把 state:task-groups 分流到本机广播。
  // state:task-groups 通道只走 controllerBroadcast。
  // 其余 channel 仍走 connectionServices.broadcastService。
  // 订阅句柄同时释放 remote 与 controller 两侧监听。
  const controllerGroups = params.sourceServices?.getOptional(ITaskGroupService);
  const controllerBroadcast = params.sourceServices?.getOptional(IBroadcastService);
  if (controllerGroups) services.register(ITaskGroupService, controllerGroups);
  if (controllerGroups && controllerBroadcast) {
    const remoteBroadcast = params.connectionServices.broadcastService;
    services.register(IBroadcastService, {
      send: (message) =>
        (message.channel === "state:task-groups" ? controllerBroadcast : remoteBroadcast).send(
          message,
        ),
      acquireClaim: (key) => remoteBroadcast.acquireClaim(key),
      commitClaim: (lease) => remoteBroadcast.commitClaim(lease),
      releaseClaim: (lease) => remoteBroadcast.releaseClaim(lease),
      tryClaim: (key) => remoteBroadcast.tryClaim(key),
      onMessage: (listener) => {
        const remote = remoteBroadcast.onMessage((event) => {
          if (event.channel !== "state:task-groups") listener(event);
        });
        const local = controllerBroadcast.onMessage((event) => {
          if (event.channel === "state:task-groups") listener(event);
        });
        return {
          dispose: () => {
            remote.dispose();
            local.dispose();
          },
        };
      },
    });
  }
  // 装配后自检：任何「合同有、集合无」或「清单有、集合无」的项都视为装配错误。
  // 这里宁可抛错也不返回部分集合，否则 attach 后才会在具体调用上暴露 Unknown channel，
  // 定位成本远高于启动期失败。
  const registrationKeys = new Set(REMOTE_WORKSPACE_RPC_REGISTRATIONS.map(([key]) => key));
  const missing = [
    ...REMOTE_WORKSPACE_RPC_CHANNELS.filter((key) => !registrationKeys.has(key)),
    ...REMOTE_WORKSPACE_RPC_REGISTRATIONS.filter(
      ([, descriptor]) =>
        services.getOptional(descriptor as ServiceDescriptor<unknown>) === undefined,
    ).map(([key]) => key),
  ];
  if (missing.length > 0) {
    throw new Error(`Remote workspace RPC registration incomplete: ${missing.join(", ")}`);
  }
  registerRemoteProviderProvisioningExecutor(services, remoteProviderProvisioningExecutor);
  return services;
}
