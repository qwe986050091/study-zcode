// Desktop 侧连接物理 Source Server 的入口。
//
// 职责：在通用 duplex 连接之上挂载 Desktop 私有能力：topic 资源反向中继、每代物理连接
// 重新同步动态工作流的用户选择。
// 输入输出：输入连接选项与 deps（resolveServices / getBots / readDynamicWorkflowMode /
// onModeSyncError）；输出 ServerRemoteConnection（services / serverInfo / dispose）。
// 副作用：建立远端连接、注册 topic 中继；syncDynamicWorkflowUserMode 会改远端状态。
// 失败语义：连接失败时 dispose 中继与半成品连接后重新抛出；模式同步失败只回调
// onModeSyncError，不阻断连接（旧版 Source 不认识该方法）。
// 维护的不变量（#18）：desktop 私有回查与设置初始化跟随「每代物理连接」重建；
// connection 在闭包中只指向当次成功连接，避免重连后残留旧 dispose。

import type { IBotsService, ServiceCollection } from "@zcode/services";
import type { DynamicWorkflowMode, WindowHostAttachmentScope } from "@zcode/shared";
import {
  connectServerRemoteOverDuplex,
  type ServerRemoteConnection,
  type ServerRemoteDuplexConnectionOptions,
} from "./serverRemoteConnection.js";
import { createWindowTopicResourceRelay } from "./windowTopicResourceRelay.js";

// 建立连接并在同一次生命周期内完成模式同步。
// 顺序：先拿到 connection 再同步 mode；同步必须发生在物理连接发布给 manager 之前，
// 否则 manager 自动重连会直接换 services，旧用户选择就丢失了。
// onClose 中 relay.dispose 必须先于 options.onClose：中继依赖 peerAgentService，
// 连接关闭后继续存在会指向已销毁的服务。
// 失败语义：外层 catch 负责 relay + connection 双清理；内层 mode 同步失败被隔离。
/** Desktop 私有回查与设置初始化跟随物理 Source 连接，每次重连重新建立。 */
export async function connectDesktopSourceServer(
  options: ServerRemoteDuplexConnectionOptions,
  deps: {
    connectServer?: typeof connectServerRemoteOverDuplex;
    resolveServices(scope: WindowHostAttachmentScope): ServiceCollection;
    getBots(): IBotsService | undefined;
    readDynamicWorkflowMode(): Promise<DynamicWorkflowMode | undefined>;
    onModeSyncError(error: unknown): void;
  },
): Promise<ServerRemoteConnection> {
  let connection: ServerRemoteConnection | undefined;
  const relay = createWindowTopicResourceRelay({
    getPeerAgentService: () => connection?.services.zcodeAgentService,
    resolveServices: deps.resolveServices,
    getBots: deps.getBots,
  });
  try {
    connection = await (deps.connectServer ?? connectServerRemoteOverDuplex)({
      ...options,
      topicResourceChannel: relay.channel,
      onClose(event) {
        relay.dispose();
        options.onClose?.(event);
      },
    });
    // 旧链路在 logical handle 初建时推送；迁移后必须在每代物理连接发布前同步，
    // 否则 manager 自动重连直接换 services，会丢失 Desktop 的当前用户选择。
    try {
      const mode = await deps.readDynamicWorkflowMode().catch(() => undefined);
      await connection.services.zcodeAgentService.syncDynamicWorkflowUserMode(mode ? { mode } : {});
    } catch (error) {
      // 旧版 Source 不认识此方法时保持可连接，与既有 workflow 同步兼容策略一致。
      deps.onModeSyncError(error);
    }
    const connected = connection;
    return {
      serverInfo: connected.serverInfo,
      services: connected.services,
      dispose() {
        relay.dispose();
        connected.dispose();
      },
    };
  } catch (error) {
    relay.dispose();
    connection?.dispose();
    throw error;
  }
}
