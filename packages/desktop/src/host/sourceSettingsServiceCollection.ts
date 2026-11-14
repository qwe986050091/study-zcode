// Source settings attachment 的服务面装配与摘除判定（#18 中 source-settings scope 的专用路径）。
//
// 为什么单独一套：source settings 只允许桌面侧（clientMode 非 web-remote-replayable）访问，
// 且只暴露「远端配置面」；模型 Provider 设置永远绑定本地 Environment，远端 Provider 事实
// 只经 Provisioning 单向下发，因此这里刻意不注册 provider-settings / model-selection，
// 避免手机侧通过 source-settings scope 间接改写本机 Provider 配置。
// 生命周期口径：attachment 与「连接代际」绑定——只有 state === online 的当前代际可以继续
// 提供设置服务，任何非 online（重连中、updating、失败）都必须先摘除，否则会对着已释放的
// 旧连接调用。这与 windowHostAttachmentRegistry 的 stale 清理形成双保险。
// 失败语义：本文件不做网络调用，不做校验抛错；装配本身不会失败（accessor 已由上层保证）。

import {
  ServiceCollection,
  ICredentialService,
  IOAuthService,
  ICodingPlanSubscriptionService,
  ISettingService,
  ISystemService,
  ISourceServerWorkspaceService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ICommandsService,
  IHooksService,
  ISubagentsService,
  IMemoryService,
  IOutputStyleService,
  ISettingsSyncService,
  type IServiceAccessor,
  type ServiceDescriptor,
} from "@zcode/services";
import type { SourceServerConnectionState } from "@zcode/shared";

// 判定某连接状态是否必须摘除 source-settings attachment（#18 生命周期口径）。
// 输入：连接状态机当前值；输出：true = 立即 detachSourceSettingsAttachments，false = 保持。
// 口径：只有 online 是「可服务」状态；updating 也可能已经 dispose 旧连接，因此同样摘除，
// 由新代际 attach 时重新建立，宁可短暂不可用也不让请求落到已释放的连接上。
// 副作用：无，纯判定。
export function shouldDetachSourceSettingsAttachment(state: SourceServerConnectionState): boolean {
  // 只有 online generation 可继续服务设置，updating 也可能已经 dispose 旧连接。
  return state !== "online";
}

/**
 * Source settings attachment 只暴露 skills/MCP/plugins/hooks/settings-sync 等远端配置面。
 * 模型 Provider 设置永远绑定本地 Environment，远端 Provider 事实只经 Provisioning 单向下发，
 * 因此这里不注册 provider-settings / model-selection。
 */
// 输入：IServiceAccessor（RPC 访问面）或已装配的 ServiceCollection；输出：独立的新集合。
// read 适配两种来源：已是集合就直接 get（保证 descriptor 一致），否则从 accessor 取属性；
// 这样同一函数既能用在首装配，也能用在已有集合上做「子集裁剪」，调用方无需区分。
// 副作用：仅创建新集合，不修改入参；返回的集合与原集合相互独立（后续注册不会回写）。
// 失败语义：目标服务缺失时 get/属性访问会抛错——这是刻意的，缺项必须在装配期暴露。
export function createSourceSettingsServiceCollection(
  services: IServiceAccessor | ServiceCollection,
): ServiceCollection {
  const read = <T>(descriptor: ServiceDescriptor<T>, get: (accessor: IServiceAccessor) => T): T =>
    services instanceof ServiceCollection ? services.get(descriptor) : get(services);
  return new ServiceCollection()
    .register(
      ICredentialService,
      read(ICredentialService, (accessor) => accessor.credentialService),
    )
    .register(
      IOAuthService,
      read(IOAuthService, (accessor) => accessor.oauthService),
    )
    .register(
      ICodingPlanSubscriptionService,
      read(ICodingPlanSubscriptionService, (accessor) => accessor.codingPlanSubscriptionService),
    )
    .register(
      ISettingService,
      read(ISettingService, (accessor) => accessor.settingService),
    )
    .register(
      ISystemService,
      read(ISystemService, (accessor) => accessor.systemService),
    )
    .register(
      ISourceServerWorkspaceService,
      read(ISourceServerWorkspaceService, (accessor) => accessor.sourceServerWorkspaceService),
    )
    .register(
      ISkillsService,
      read(ISkillsService, (accessor) => accessor.skillsService),
    )
    .register(
      ISkillSyncService,
      read(ISkillSyncService, (accessor) => accessor.skillSyncService),
    )
    .register(
      IMcpSyncService,
      read(IMcpSyncService, (accessor) => accessor.mcpSyncService),
    )
    .register(
      IPluginSyncService,
      read(IPluginSyncService, (accessor) => accessor.pluginSyncService),
    )
    .register(
      IPluginsService,
      read(IPluginsService, (accessor) => accessor.pluginsService),
    )
    .register(
      IPluginManagementService,
      read(IPluginManagementService, (accessor) => accessor.pluginManagementService),
    )
    .register(
      ICommandsService,
      read(ICommandsService, (accessor) => accessor.commandsService),
    )
    .register(
      IHooksService,
      read(IHooksService, (accessor) => accessor.hooksService),
    )
    .register(
      ISubagentsService,
      read(ISubagentsService, (accessor) => accessor.subagentsService),
    )
    .register(
      IMemoryService,
      read(IMemoryService, (accessor) => accessor.memoryService),
    )
    .register(
      IOutputStyleService,
      read(IOutputStyleService, (accessor) => accessor.outputStyleService),
    )
    .register(
      ISettingsSyncService,
      read(ISettingsSyncService, (accessor) => accessor.settingsSyncService),
    );
}
