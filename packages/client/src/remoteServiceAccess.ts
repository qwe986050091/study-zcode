// 模块职责：把 ChannelClient 上的 RPC channel 映射为一组类型安全的服务代理，供上层按字段直接取用。
// 边界：只做代理绑定，不持有业务状态、不做重试、不做鉴权判定，也不建立或恢复连接。
// 生命周期：实例与持有它的 scope 同生共死；channel 断开后代理对象仍存在，只是调用失败。
// 改动前先确认 host 是否注册了对应 descriptor，未注册的 channel 只会在首次调用时暴露问题。
// INV-01 每个服务字段必须绑定与之同名的 channel，禁止跨 channel 复用代理；守住位置：constructor 内各 ProxyChannel.toService 赋值；改错故障：调用落到错误的 handler，界面拿到别家服务的数据
// INV-02 providerProvisioningTargetService 必须以不可枚举属性定义，避免被遍历与序列化带走；守住位置：Object.defineProperty 分支；改错故障：日志或状态快照中出现 Secret 写入入口，凭据可被读取
// INV-03 windowProjectDirectory 只在选项显式开启时构造，缺省保持 undefined；守住位置：constructor 首个 if 分支；改错故障：远端工作区被迫构造本地目录组，项目语义退化为本地路径
// INV-04 sourceServerManagementService 必须由选项能力位决定是否绑定；守住位置：三元表达式分支；改错故障：未注册 channel 的 scope 拿到看似可用的代理，首次调用才抛错
// INV-05 ProxyChannel 代理由惰性构造产生，构造成功不代表服务端已注册；守住位置：整个 constructor；改错故障：把可选能力当作必然存在，失败堆栈远离真正根因
// INV-06 所有 readonly 字段必须在 constructor 内同步赋值完毕，不留下半初始化实例；守住位置：constructor 末尾；改错故障：调用方读到 undefined 代理，访问时抛类型错误
// INV-07 cuaPermissionService 在接口上可选，但此处必须按非可选绑定；守住位置：cuaPermissionService 赋值；改错故障：桌面端权限面板拿到 undefined，相关能力整体不可用
// INV-08 sourceServerManagementService 字段本身仍保留可选修饰，与赋值分支保持一致；守住位置：字段声明区；改错故障：类型层面强制消费方判空，非桌面 scope 编译期即失败
// INV-09 fileService 属于基础能力，必须早于依赖文件读写的服务完成绑定；守住位置：fileService 赋值位置；改错故障：预览与附件链路在文件读取阶段读不到代理
// INV-10 mediaPreviewService 不得因 host 已注册 channel 而省略本地绑定；守住位置：mediaPreviewService 赋值；改错故障：预览面板回退到受限读取，大体积视频无法打开
// INV-11 每个代理都使用 toService 泛型显式标注接口类型，不依赖推断；守住位置：全部赋值语句；改错故障：类型退化为任意，接口漂移在编译期不可见
// INV-12 constructor 的选项参数默认值必须是空对象，保证无参实例化安全；守住位置：constructor 参数默认值；改错故障：直接实例化时读取 undefined 属性立即抛错
// INV-13 窗口目录组的三个子服务必须一次成型，禁止部分初始化；守住位置：windowProjectDirectory 对象字面量；改错故障：变更服务缺失导致变更面板空白或崩溃
// INV-14 凭据与鉴权类代理不得附加本地缓存层；守住位置：credentialService 与 oauthService 赋值；改错故障：登出后仍读到旧 token，登录态判断失真
// INV-15 插件相关代理保持独立字段，禁止合并成聚合门面；守住位置：plugin 系列赋值；改错故障：插件桥与采样能力互相串味，调用路由错位
// INV-16 字段集合与 IServiceAccessor 成员一一对应，新增服务必须同步两侧；守住位置：class 字段声明区；改错故障：类型检查通过但运行期取不到代理
// INV-17 全部赋值必须发生在 constructor 作用域内，禁止延迟到方法或事件回调；守住位置：constructor 整体；改错故障：首帧渲染访问服务时字段尚未就绪
// INV-18 代理字段保持 readonly，禁止运行期重新赋值；守住位置：字段修饰符；改错故障：热更新后新旧 channel 并存，消息发往已销毁的连接
import { IGenUiService } from "@zcode/services";
import { ProxyChannel, type IChannelClient } from "@zcode/rpc";
import {
  IFileService,
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
  IProjectService,
  ITaskGroupService,
  IRemoteProjectService,
  ICuaPermissionService,
  IConversationShareService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IModelSelectionService,
  IProviderSettingsService,
  IProviderProvisioningTargetService,
  ISourceServerWorkspaceService,
  ISourceServerManagementService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  ICloudContentService,
  IMarketingTouchService,
  IOffPeakTaskService,
  IHighspeedCardService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginUiAppToolsService,
  IPluginUiSamplingService,
  IPluginUiBridgeService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  IOutputStyleService,
  ISettingsSyncService,
  IFeedbackService,
  IPromptAttachmentTransferService,
  IWindowControllerService,
  IWindowProjectService,
  IWindowRemoteProjectService,
  IWindowProjectChangesService,
  type WindowProjectDirectoryServices,
  type IServiceAccessor,
} from "@zcode/services";

/**
 * RemoteServiceAccess — 通过 ChannelClient 自动创建类型安全的服务代理
 *
 * 新增服务只需在此添加一个 getter。
 */
// [权衡] 用一个类集中持有全部代理，换取调用点无需关心 channel 名称的便利
// [权衡] 代价是新增服务要同步改三处：服务包 descriptor、host 注册、本类字段与构造赋值
// [约束] 字段顺序即构造顺序，被其他服务依赖的基础能力应排在前面
// [失败路径] 漏掉某个字段的赋值不会在类型检查阶段暴露，只在首次访问时抛错
// [边界] 本类不负责连接建立与重连，channel 可用的前提由上层 scope 保证
export class RemoteServiceAccess implements IServiceAccessor {
  // [权衡] 窗口目录组以整体可选的形式暴露，避免远端场景被迫构造本地目录语义
  // [失败路径] 置为 undefined 时消费方必须改走 remoteProjectService 分支
  // [约束] 标志位来自构造选项而非运行期探测，保证同一 scope 内能力视图稳定
  // [并发] 选项在构造时定型，切换工作区应新建实例而不是改写字段
  readonly windowProjectDirectory?: WindowProjectDirectoryServices;
  // [资源] 文件读写是预览与附件链路的地基，因此在必需字段中最先绑定
  // [失败路径] channel 缺失时此处仍会构造出代理，错误推迟到第一次读写
  // [约束] 该字段不允许为 undefined，消费方无需做存在性判断
  // [权衡] 构造期不做能力探测以保持零 IO，代价是错误定位依赖调用栈
  readonly fileService: IFileService;
  readonly mediaPreviewService: IMediaPreviewService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  readonly onboardingRecordService: IOnboardingRecordService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly zcodeTaskService: IZCodeTaskService;
  readonly windowControllerService: IWindowControllerService;
  // [约束] agent 与 session 两类服务必须分别绑定，不能共用一个 channel
  // [失败路径] 二者混用会让 session 事件发到 agent 侧 handler，消息静默丢失
  // [并发] 代理本身无状态，并发调用的安全性由远端服务端保证
  // [权衡] 客户端不做请求合并，避免掩盖服务端既有的顺序语义
  readonly zcodeAgentService: IZCodeAgentService;
  readonly zcodeSessionService: IZCodeSessionService;
  readonly taskGroupService: ITaskGroupService;
  readonly projectService: IProjectService;
  readonly remoteProjectService: IRemoteProjectService;
  // cuaPermissionService 在 IServiceAccessor 上是可选（远端/bots host 不提供），但桌面 renderer
  // 经 RPC 一定能拿到（main host 始终注册此 descriptor；非 macOS / 未启用时方法返回 available:false）。
  readonly cuaPermissionService: ICuaPermissionService;
  readonly conversationShareService: IConversationShareService;
  readonly botsService: IBotsService;
  readonly fileWatcherService: IFileWatcherService;
  readonly oauthService: IOAuthService;
  readonly providerSettingsService: IProviderSettingsService;
  readonly modelSelectionService: IModelSelectionService;
  /** Host-only target proxy；不属于 IServiceAccessor，避免向 Renderer 暴露 Secret 写入接口。 */
  readonly providerProvisioningTargetService!: IProviderProvisioningTargetService;
  readonly sourceServerWorkspaceService: ISourceServerWorkspaceService;
  /** 仅 desktop base attachment 注册；其他 scope 必须按可选能力消费。 */
  readonly sourceServerManagementService?: ISourceServerManagementService;
  readonly usageStatsService: IUsageStatsService;
  readonly codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  readonly clientConfigService: IClientConfigService;
  readonly clientScenesService: IClientScenesService;
  readonly cloudContentService: ICloudContentService;
  readonly marketingTouchService: IMarketingTouchService;
  readonly offPeakTaskService: IOffPeakTaskService;
  readonly highspeedCardService: IHighspeedCardService;
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly mcpSyncService: IMcpSyncService;
  readonly genUiService: IGenUiService;
  readonly pluginUiBridgeService: IPluginUiBridgeService;
  readonly pluginUiSamplingService: IPluginUiSamplingService;
  readonly pluginUiAppToolsService: IPluginUiAppToolsService;
  readonly pluginSyncService: IPluginSyncService;
  readonly pluginsService: IPluginsService;
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly outputStyleService: IOutputStyleService;
  readonly settingsSyncService: ISettingsSyncService;
  readonly feedbackService: IFeedbackService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;

  // [约束] 构造顺序固定：先处理可选的窗口目录组，再逐个绑定必需服务
  // [失败路径] 构造过程不抛错，channel 缺失一律延迟到调用期才暴露
  // [权衡] 用惰性代理换取启动速度，代价是缺少早期失败信号
  // [并发] 实例不保证跨线程可见，构造必须在单一线程内完成后再共享
  // [资源] 此处不订阅事件也不持有定时器，避免实例需要额外的销毁钩子
  constructor(
    channelClient: IChannelClient,
    options: { sourceServerManagementService?: boolean; windowProjectDirectory?: boolean } = {},
  ) {
    // 远端工作区的 project 必须保留 Source 语义；只有显式能力才创建完整窗口目录组。
    if (options.windowProjectDirectory) {
      // [事务] 三个子服务在同一对象字面量内一次成型，不出现半套目录服务
      // [约束] 子服务使用窗口专用 channel，不能复用全局 projectService
      // [失败路径] 复用全局 channel 会让窗口切换后仍读写旧工作区
      // [权衡] 整体可选而非逐项可选，减少消费方的分支组合数量
      this.windowProjectDirectory = {
        projectService: ProxyChannel.toService(
          channelClient.getChannel(IWindowProjectService.channelName),
        ),
        remoteProjectService: ProxyChannel.toService(
          channelClient.getChannel(IWindowRemoteProjectService.channelName),
        ),
        changesService: ProxyChannel.toService(
          channelClient.getChannel(IWindowProjectChangesService.channelName),
        ),
      };
    }
    // [约束] 基础能力优先绑定，后续服务的回调可能在其内部读文件
    // [失败路径] 若把此项移到末尾，早期回调会读到 undefined 字段
    // [资源] 代理只保存 channel 引用而不持有连接，可安全长期存活
    // [权衡] 不缓存方法引用，保证热更新后调用走新的 channel
    this.fileService = ProxyChannel.toService<IFileService>(
      channelClient.getChannel(IFileService.channelName),
    );
    // Host 已注册 media-preview channel，但遗漏 renderer proxy 时，PreviewPane
    // 会静默回退到 8 MiB 的 file.readMediaPreview，导致大 MP4 无法打开。
    this.mediaPreviewService = ProxyChannel.toService<IMediaPreviewService>(
      channelClient.getChannel(IMediaPreviewService.channelName),
    );
    this.gitService = ProxyChannel.toService<IGitService>(
      channelClient.getChannel(IGitService.channelName),
    );
    this.gitCheckpointService = ProxyChannel.toService<IGitCheckpointService>(
      channelClient.getChannel(IGitCheckpointService.channelName),
    );
    this.systemService = ProxyChannel.toService<ISystemService>(
      channelClient.getChannel(ISystemService.channelName),
    );
    this.terminalService = ProxyChannel.toService<ITerminalService>(
      channelClient.getChannel(ITerminalService.channelName),
    );
    this.settingService = ProxyChannel.toService<ISettingService>(
      channelClient.getChannel(ISettingService.channelName),
    );
    this.onboardingRecordService = ProxyChannel.toService<IOnboardingRecordService>(
      channelClient.getChannel(IOnboardingRecordService.channelName),
    );
    // [安全] 凭据代理只做转发，明文凭据不在客户端内存中留存
    // [失败路径] 改成带缓存的单例会让登出后仍能读到旧 token
    // [约束] 鉴权结果以远端返回为准，客户端不预判登录态
    // [权衡] 不做本地兜底存储，离线时直接失败而非返回过期凭据
    this.credentialService = ProxyChannel.toService<ICredentialService>(
      channelClient.getChannel(ICredentialService.channelName),
    );
    this.broadcastService = ProxyChannel.toService<IBroadcastService>(
      channelClient.getChannel(IBroadcastService.channelName),
    );
    this.zcodeTaskService = ProxyChannel.toService<IZCodeTaskService>(
      channelClient.getChannel(IZCodeTaskService.channelName),
    );
    this.windowControllerService = ProxyChannel.toService<IWindowControllerService>(
      channelClient.getChannel(IWindowControllerService.channelName),
    );
    this.zcodeAgentService = ProxyChannel.toService<IZCodeAgentService>(
      channelClient.getChannel(IZCodeAgentService.channelName),
    );
    this.remoteProjectService = ProxyChannel.toService<IRemoteProjectService>(
      channelClient.getChannel(IRemoteProjectService.channelName),
    );
    this.taskGroupService = ProxyChannel.toService<ITaskGroupService>(
      channelClient.getChannel(ITaskGroupService.channelName),
    );
    this.projectService = ProxyChannel.toService<IProjectService>(
      channelClient.getChannel(IProjectService.channelName),
    );
    this.zcodeSessionService = ProxyChannel.toService<IZCodeSessionService>(
      channelClient.getChannel(IZCodeSessionService.channelName),
    );
    // [约束] 此处按非可选绑定，与接口上的可选声明形成刻意的差异
    // [失败路径] 桌面 host 必然注册该 descriptor，缺失说明版本不匹配
    // [权衡] 以运行期必然存在换取调用点零分支，代价是错误更晚暴露
    // [边界] 非目标平台或未启用时由方法返回不可用状态，而不是字段为空
    this.cuaPermissionService = ProxyChannel.toService<ICuaPermissionService>(
      channelClient.getChannel(ICuaPermissionService.channelName),
    );
    this.conversationShareService = ProxyChannel.toService<IConversationShareService>(
      channelClient.getChannel(IConversationShareService.channelName),
    );
    this.botsService = ProxyChannel.toService<IBotsService>(
      channelClient.getChannel(IBotsService.channelName),
    );
    this.fileWatcherService = ProxyChannel.toService<IFileWatcherService>(
      channelClient.getChannel(IFileWatcherService.channelName),
    );
    this.oauthService = ProxyChannel.toService<IOAuthService>(
      channelClient.getChannel(IOAuthService.channelName),
    );
    this.providerSettingsService = ProxyChannel.toService<IProviderSettingsService>(
      channelClient.getChannel(IProviderSettingsService.channelName),
    );
    this.modelSelectionService = ProxyChannel.toService<IModelSelectionService>(
      channelClient.getChannel(IModelSelectionService.channelName),
    );
    // [安全] 用不可枚举属性承载 host-only 代理，避免被展开或序列化带走
    // [失败路径] 改成普通赋值会让日志与状态快照中出现 Secret 写入入口
    // [约束] 该字段不属于 IServiceAccessor，消费方必须显式向下转型
    // [权衡] 省略 writable 使属性默认只读，用隐式默认代替显式冻结
    // [资源] defineProperty 不产生订阅关系，无需配对清理逻辑
    Object.defineProperty(this, "providerProvisioningTargetService", {
      value: ProxyChannel.toService<IProviderProvisioningTargetService>(
        channelClient.getChannel(IProviderProvisioningTargetService.channelName),
      ),
      enumerable: false,
    });
    // [约束] workspace 与 management 是两个独立 channel，不可互相替代
    // [失败路径] 把 management 当 workspace 使用会拿到错误的目录根
    // [并发] 两者均无本地状态，可被多个窗口实例共享同一连接
    // [权衡] 拆分字段让可选能力的影响面收敛到 management 一处
    this.sourceServerWorkspaceService = ProxyChannel.toService<ISourceServerWorkspaceService>(
      channelClient.getChannel(ISourceServerWorkspaceService.channelName),
    );
    // Bug 原因：ProxyChannel 是惰性的，无论服务端是否注册 channel 都能构造出“看似存在”
    // 的对象，optional 合同因此在首次调用时才失败。scope 创建时必须显式声明能力。
    this.sourceServerManagementService = options.sourceServerManagementService
      ? ProxyChannel.toService<ISourceServerManagementService>(
          channelClient.getChannel(ISourceServerManagementService.channelName),
        )
      : undefined;
    this.usageStatsService = ProxyChannel.toService<IUsageStatsService>(
      channelClient.getChannel(IUsageStatsService.channelName),
    );
    this.codingPlanSubscriptionService = ProxyChannel.toService<ICodingPlanSubscriptionService>(
      channelClient.getChannel(ICodingPlanSubscriptionService.channelName),
    );
    this.clientConfigService = ProxyChannel.toService<IClientConfigService>(
      channelClient.getChannel(IClientConfigService.channelName),
    );
    this.clientScenesService = ProxyChannel.toService<IClientScenesService>(
      channelClient.getChannel(IClientScenesService.channelName),
    );
    this.cloudContentService = ProxyChannel.toService<ICloudContentService>(
      channelClient.getChannel(ICloudContentService.channelName),
    );
    this.marketingTouchService = ProxyChannel.toService<IMarketingTouchService>(
      channelClient.getChannel(IMarketingTouchService.channelName),
    );
    this.offPeakTaskService = ProxyChannel.toService<IOffPeakTaskService>(
      channelClient.getChannel(IOffPeakTaskService.channelName),
    );
    this.highspeedCardService = ProxyChannel.toService<IHighspeedCardService>(
      channelClient.getChannel(IHighspeedCardService.channelName),
    );
    this.skillsService = ProxyChannel.toService<ISkillsService>(
      channelClient.getChannel(ISkillsService.channelName),
    );
    this.skillSyncService = ProxyChannel.toService<ISkillSyncService>(
      channelClient.getChannel(ISkillSyncService.channelName),
    );
    this.mcpSyncService = ProxyChannel.toService<IMcpSyncService>(
      channelClient.getChannel(IMcpSyncService.channelName),
    );
    // [约束] 生成式 UI 服务独立于插件桥，二者消费路径不同
    // [失败路径] 把生成式 UI 并入插件桥会让非插件场景被迫加载插件依赖
    // [权衡] 单独字段换取按需使用，代价是字段数量继续增长
    // [并发] 渲染侧调用可能并发到达，顺序保证由远端而非此处提供
    this.genUiService = ProxyChannel.toService<IGenUiService>(
      channelClient.getChannel(IGenUiService.channelName),
    );
    this.pluginUiBridgeService = ProxyChannel.toService<IPluginUiBridgeService>(
      channelClient.getChannel(IPluginUiBridgeService.channelName),
    );
    this.pluginUiSamplingService = ProxyChannel.toService<IPluginUiSamplingService>(
      channelClient.getChannel(IPluginUiSamplingService.channelName),
    );
    this.pluginUiAppToolsService = ProxyChannel.toService<IPluginUiAppToolsService>(
      channelClient.getChannel(IPluginUiAppToolsService.channelName),
    );
    this.pluginSyncService = ProxyChannel.toService<IPluginSyncService>(
      channelClient.getChannel(IPluginSyncService.channelName),
    );
    this.pluginsService = ProxyChannel.toService<IPluginsService>(
      channelClient.getChannel(IPluginsService.channelName),
    );
    this.pluginManagementService = ProxyChannel.toService<IPluginManagementService>(
      channelClient.getChannel(IPluginManagementService.channelName),
    );
    this.subagentsService = ProxyChannel.toService<ISubagentsService>(
      channelClient.getChannel(ISubagentsService.channelName),
    );
    // [约束] 命令、钩子、记忆三组服务各自独立绑定，互不代偿
    // [失败路径] 合并绑定会让钩子异常连带命令列表不可用
    // [权衡] 接受字段冗余而不做隐式聚合，便于逐项做能力降级
    this.commandsService = ProxyChannel.toService<ICommandsService>(
      channelClient.getChannel(ICommandsService.channelName),
    );
    this.hooksService = ProxyChannel.toService<IHooksService>(
      channelClient.getChannel(IHooksService.channelName),
    );
    this.memoryService = ProxyChannel.toService<IMemoryService>(
      channelClient.getChannel(IMemoryService.channelName),
    );
    this.outputStyleService = ProxyChannel.toService<IOutputStyleService>(
      channelClient.getChannel(IOutputStyleService.channelName),
    );
    this.settingsSyncService = ProxyChannel.toService<ISettingsSyncService>(
      channelClient.getChannel(ISettingsSyncService.channelName),
    );
    this.feedbackService = ProxyChannel.toService<IFeedbackService>(
      channelClient.getChannel(IFeedbackService.channelName),
    );
    // [约束] 字段集合覆盖 IServiceAccessor 全集，新增成员需在此收尾前补齐
    // [失败路径] 漏绑不会被类型系统发现，因为声明与赋值分处两段
    // [权衡] 除 host-only 一处外不使用非空断言，依赖构造完整性保证就绪
    // [资源] 构造结束即视为完全就绪，不存在异步补绑阶段
    this.promptAttachmentTransferService = ProxyChannel.toService<IPromptAttachmentTransferService>(
      channelClient.getChannel(IPromptAttachmentTransferService.channelName),
    );
  }
}
