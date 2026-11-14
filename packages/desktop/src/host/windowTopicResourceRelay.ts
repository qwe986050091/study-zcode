// 窗口级的 Topic 资源反向请求中继。
//
// 职责：为远端连接提供 topic resource 的 reply / validate / read 三个反向通道，并在每次
// 请求时校验「发起连接的身份」。核心约束：不能只比较文件路径，必须把请求的 remote 三元组
// 重新解析成服务集合，并要求其中的 IZCodeAgentService 与当前物理连接的 peer 完全相同。
// 输入输出：输入 peer/bots 提供方与 resolveServices；输出由 createTopicResourceRelayChannel
// 生成的 channel 实现。
// 副作用：只读依赖查询；真正的 reply 会通过 BotsService 往会话里发消息。
// 失败语义：连接不匹配、缺 bots 能力、reply scope 缺字段、bot 无 replyToChannel 均抛错。

import { IZCodeAgentService, type IBotsService, type ServiceCollection } from "@zcode/services";
import { createTopicResourceRelayChannel } from "@zcode/services/node";
import type { WindowHostAttachmentScope, ZCodeTopicResourceRelayRequest } from "@zcode/shared";

/** 反向请求必须属于发起它的物理连接，并仍绑定当前 logical session，不能只比较文件路径。 */
// 把请求的 remote 三元组解析回服务集合，并校验它确实属于当前 peer 连接。
// 只比较 workspacePath 不够：同一路径可能同时挂载在多个 Source/会话上，必须用
// resolveServices 重新获取 IZCodeAgentService 实例做引用相等判断，才能确认「这条反向请求
// 来自发起它的物理连接」。同时要求 bots 具备 read/validate 能力。
// 失败语义：peer 不存在、实例不匹配、bots 能力缺失均抛错（fail-closed）。
export function createWindowTopicResourceRelay(deps: {
  getPeerAgentService(): IZCodeAgentService | undefined;
  resolveServices(scope: WindowHostAttachmentScope): ServiceCollection;
  getBots(): IBotsService | undefined;
}) {
  // 反向请求的身份校验入口：每次 reply/validate/read 都重新解析，不做连接级缓存。
  // 失败语义：throw（由 channel 层转成 RPC error），调用方不得降级为「按路径放行」。
  const resolve = (
    request: Pick<
      ZCodeTopicResourceRelayRequest,
      "remoteSessionId" | "workspaceIdentity" | "workspacePath"
    >,
  ) => {
    const peer = deps.getPeerAgentService();
    if (
      !peer ||
      deps
        .resolveServices({
          kind: "remote",
          remoteSessionId: request.remoteSessionId,
          workspaceIdentity: request.workspaceIdentity,
          workspacePath: request.workspacePath,
        })
        .get(IZCodeAgentService) !== peer
    )
      throw new Error("Topic resource source connection mismatch");
    const bots = deps.getBots();
    if (!bots?.readTopicResource || !bots.validateTopicResource)
      throw new Error("Desktop topic resource service unavailable");
    return bots;
  };
  return createTopicResourceRelayChannel({
    reply: (request) => {
      if (!request.remoteSessionId || !request.workspaceIdentity)
        throw new Error("Remote channel reply scope missing");
      const bots = resolve({
        ...request,
        remoteSessionId: request.remoteSessionId,
        workspaceIdentity: request.workspaceIdentity,
      });
      if (!bots.replyToChannel) throw new Error("Bot channel reply unavailable");
      return bots.replyToChannel(request);
    },
    validate: (request, signal) => resolve(request).validateTopicResource!({ ...request, signal }),
    read: (request, signal) => resolve(request).readTopicResource!({ ...request, signal }),
  });
}
