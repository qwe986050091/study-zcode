// 窗口 Host attachment 的「服务暴露策略」唯一决策点。
//
// 大纲不变量 #18（clientMode 语义）在此落地：
// - desktop-continuous 返回 undefined（交给底层默认策略，即暴露完整 ServiceCollection）；
// - web-remote-replayable 返回显式 allowlist：未列入的 channel 默认 fail-closed，
//   避免新注册的高权限 channel 自动泄漏给手机（历史 bug：Terminal 可直接建 PTY）。
// - allowlist 是白名单而非黑名单，新增 channel 必须人工审阅后再加；跨 Environment 写凭据的
//   ProviderProvisioningTarget 这类 channel 明确禁止进入手机白名单。
//
// 另外两个正交约束：
// - 手机侧不共享远端 ServiceCollection 里的 project/remoteProjects 实例，改为在窗口级
//   ServiceCollection 里用 IWindowProjectService / IWindowRemoteProjectService 另组一套，
//   避免替换原 project 破坏工作区 mentions 等调用；
// - 暴露失败必须整体失败（先取齐所有必需服务再发布），不允许发布半套频道。

import type { IChannelServer } from "@zcode/rpc";
import {
  ServiceCollection,
  IProjectService,
  IRemoteProjectService,
  IBroadcastService,
  IWindowProjectService,
  IWindowRemoteProjectService,
  IWindowProjectChangesService,
  createWindowProjectChangesService,
  type ServiceExposurePolicy,
  type ZCodeAgentV4ClientMode,
} from "@zcode/services";
import { ServiceChannels } from "@zcode/shared";

// 手机（web-remote-replayable）可用的 channel 白名单。
// 每一项都表示「该 channel 的调用语义在断线重放链路下可安全恢复或幂等」；非幂等的写入类
// 能力（如 Terminal、Source 管理）不得加入。注释中标注了需要人工确认边界的条目。
const WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS = new Set<string>([
  ServiceChannels.File,
  ServiceChannels.MediaPreview,
  ServiceChannels.System,
  ServiceChannels.Git,
  ServiceChannels.GitCheckpoint,
  ServiceChannels.Setting,
  // 引导记录与 settings 同属该 attachment 的 owner；漏放行时手机调用超时，回退 settings 判定误弹引导。
  ServiceChannels.OnboardingRecord,
  ServiceChannels.Credential,
  ServiceChannels.CuaPermission,
  ServiceChannels.CuaPipSession,
  ServiceChannels.Broadcast,
  ServiceChannels.ZCodeTask,
  ServiceChannels.WindowController,
  ServiceChannels.ZCodeAgent,
  ServiceChannels.ZCodeSession,
  ServiceChannels.Project,
  ServiceChannels.TaskGroups,
  ServiceChannels.RemoteProjects,
  ServiceChannels.WindowProject,
  ServiceChannels.WindowRemoteProjects,
  ServiceChannels.WindowProjectChanges,
  // ConversationShare 由 scopeConversationShareServiceForAttachment 按 clientMode 包装：手机只保留
  // getCapabilities/getPreview 只读透传，publish/import/continuation 一律 feature_disabled。
  ServiceChannels.ConversationShare,
  ServiceChannels.FileWatcher,
  ServiceChannels.OAuth,
  ServiceChannels.ProviderSettings,
  ServiceChannels.ModelSelection,
  // ProviderProvisioningTarget 携带跨 Environment 凭据写入，只允许受信 Desktop Host 调用，绝不进手机 allowlist。
  ServiceChannels.SourceServerWorkspace,
  ServiceChannels.UsageStats,
  ServiceChannels.CodingPlanSubscription,
  ServiceChannels.ClientScenes,
  ServiceChannels.Skills,
  ServiceChannels.SkillSync,
  ServiceChannels.McpSync,
  ServiceChannels.PluginSync,
  ServiceChannels.Plugins,
  ServiceChannels.PluginManagement,
  ServiceChannels.Subagents,
  ServiceChannels.Commands,
  ServiceChannels.Hooks,
  ServiceChannels.Memory,
  ServiceChannels.OutputStyle,
  ServiceChannels.SettingsSync,
  ServiceChannels.Bots,
  ServiceChannels.Feedback,
  ServiceChannels.PromptAttachmentTransfer,
  ServiceChannels.OffPeakTask,
]);

// 预构造的策略常量：只含 allowedChannels；共享引用，调用方不得修改其内容。
const WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY: ServiceExposurePolicy = {
  allowedChannels: WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS,
};

/**
 * 按 clientMode 选择服务暴露策略。
 * 输入：attachment 的 clientMode（desktop-continuous / web-remote-replayable）。
 * 输出：web-remote-replayable 返回白名单策略；desktop 返回 undefined 表示沿用默认完整暴露。
 * 副作用：无，纯函数；策略对象是模块级共享常量，调用方不得修改。
 * 失败语义：未知 clientMode 走默认完整暴露（返回 undefined），因此新增 clientMode 时必须
 * 在此显式判断，否则会被当作桌面端处理。
 */
export function resolveWindowHostServiceExposurePolicy(
  clientMode: ZCodeAgentV4ClientMode,
): ServiceExposurePolicy | undefined {
  // Bug 根因：Host 以前把完整 ServiceCollection 当成 attachment 授权，并只用 denylist
  // 排除了 Source 管理；新注册的高权限 channel 会自动暴露给手机，Terminal 因此可直接创建 PTY。
  // mobile 必须使用显式 allowlist，让未审阅 channel 默认 fail-closed；桌面继续保持完整服务面。
  return clientMode === "web-remote-replayable" ? WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY : undefined;
}

/**
 * 把 Host 服务面暴露给指定 attachment。
 * 输入：RPC server、共享 ServiceCollection、clientMode、可选 overrides、attachment scope，
 * 以及手机远端场景专用的 windowServices。
 * 输出：无返回值；副作用是把 channel 发布到 server（存在 clientMode 策略时附加白名单过滤）。
 * 失败语义：
 * - 手机远端 scope 缺少 windowServices 时抛 window-project-directory.unavailable，整次暴露失败；
 * - 窗口目录所需的三个服务若缺失，register 直接抛错，同样不会发布任何部分频道。
 * 维护的不变量：
 * - 手机远端始终走「窗口级目录服务 + 白名单」两条约束，不能退化为直接共享远端集合；
 * - desktop-continuous 不受影响，继续以完整服务面暴露（含 Source 管理等桌面专属能力）。
 */
export function exposeWindowHostAttachmentServices(params: {
  server: IChannelServer;
  services: ServiceCollection;
  clientMode: ZCodeAgentV4ClientMode;
  overrides?: ReadonlyMap<string, unknown>;
  attachmentScope?: { kind: "local" | "remote" | "source-settings" };
  windowServices?: ServiceCollection;
}): void {
  if (params.clientMode === "web-remote-replayable" && params.attachmentScope?.kind === "remote") {
    if (!params.windowServices) throw new Error("window-project-directory.unavailable");
    // 原 project 属于 Source，替换会破坏工作区内的 mentions 等调用；窗口目录另用完整频道组。
    // 先取得所有必需服务，缺失时不发布部分频道，也不修改共享远端 ServiceCollection。
    const directory = new ServiceCollection()
      .register(IWindowProjectService, params.windowServices.get(IProjectService))
      .register(IWindowRemoteProjectService, params.windowServices.get(IRemoteProjectService))
      .register(
        IWindowProjectChangesService,
        createWindowProjectChangesService(params.windowServices.get(IBroadcastService)),
      );
    directory.exposeOnChannelServer(
      params.server,
      undefined,
      resolveWindowHostServiceExposurePolicy(params.clientMode),
    );
  }
  params.services.exposeOnChannelServer(
    params.server,
    params.overrides,
    resolveWindowHostServiceExposurePolicy(params.clientMode),
  );
}
