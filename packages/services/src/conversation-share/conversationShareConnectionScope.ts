// 分享能力在「谁发起调用」上分叉：Desktop 直连、Desktop 经 Host attachment 转发、手机远控。
// 本文件是唯一的分叉点：把同一个业务 service 包装成符合当前连接身份的外观，避免业务层感知 transport。
// INV-01：写操作（preflight/publish/import/continuation）必须携带可信连接上下文，否则一律拒绝（守住它：forInput 与 reject 系列）。
// INV-02：只读查询（getCapabilities/getPreview/getImportedConversation）不因连接不可用而失败（守住它：这三处直接转发）。
// INV-03：手机远控绝不执行写操作，返回 feature_disabled 而不是伪装成功（守住它：rejectMobileShare）。
// 改错后果：要么把 Desktop 的 attachment 身份泄漏给控制端，要么手机端静默发布半成品分享。
import { Event as RpcEvent } from "@zcode/rpc";
import type { IConversationShareService } from "#src/conversation-share/conversationShare.js";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import {
  readTrustedZCodeAgentV4Connection,
  withTrustedZCodeAgentV4Connection,
  type ZCodeAgentV4ConnectionContext,
} from "#src/zcode-agent/zcodeAgentConnectionScope.js";
import { conversationShareConnectionScopeFactory } from "#src/conversation-share/conversationShareService.js";

// 只挑出需要绑定连接上下文的四个 V4 查询：rows/fileChanges/attachmentRead/attachmentStat。
// 用 Pick 而非整个 IZCodeAgentService，是为了让作用域化包装只能替换这几个方法，
// 不会意外把别的 Agent 能力也换掉（那会让后续新增方法默认走错连接）。
type ConversationShareAgentService = Pick<
  IZCodeAgentService,
  | "conversationRowsRangeV4"
  | "conversationFileChangesV4"
  | "conversationAttachmentReadV4"
  | "conversationAttachmentStatV4"
>;

// 用 Symbol 方法做能力探测：Symbol 不能被 string-command ProxyChannel 调用，
// 因此它只在同进程装配期可见，不会成为远程可调用的攻击面。
type ConnectionScopableConversationShareService = IConversationShareService & {
  [conversationShareConnectionScopeFactory](
    agentService: ConversationShareAgentService,
  ): IConversationShareService;
};

// [失败路径] 用 in + typeof 双重判断而不是 as 断言：旧版本 service 没有该方法时返回 false，
// 由调用方走「包裹 input」的兼容分支，而不是在调用处抛 TypeError。
function isConnectionScopableConversationShareService(
  service: IConversationShareService,
): service is ConnectionScopableConversationShareService {
  return (
    conversationShareConnectionScopeFactory in service &&
    typeof service[conversationShareConnectionScopeFactory] === "function"
  );
}

// 对外唯一入口：按 clientMode 决定 Desktop 实时链路还是手机恢复链路。
// desktop-continuous 允许写操作，前提是拿到可信 connection；web-remote-replayable 只允许读。
// [权衡] 不用一个通用 Proxy 统一拦截：显式逐个方法列出，新增 IConversationShareService 方法时
// 这里会编译失败，逼着作者决定该方法在新连接下应拒绝还是放行。
export function scopeConversationShareServiceForAttachment(
  service: IConversationShareService,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  agentService?: ConversationShareAgentService,
  connection?: ZCodeAgentV4ConnectionContext,
): IConversationShareService {
// Desktop 既可能是本地 Host，也可能是被远控的 Host；trusted-host-relay 表示后者。
  if (clientMode === "desktop-continuous") {
    // R3 Share 运行在 Source：沿同一受信 transport 传递 Desktop attachment 身份，
    // 不读取控制端 JWT，也不为 Share 另建 hello/connection/subscription。
// 中继场景下 connection 只是「上游可信」的证明，真正的下游身份在每个请求的 input 里，
// 所以必须逐次读取并重新绑定，不能把 connection 缓存到闭包里复用。
    if (connection?.role === "trusted-host-relay") {
// [失败路径] 任何一项缺失都抛 connection_unavailable：宁可拒绝，也不能在无身份的请求上继续，
// 否则 Host 会用自己的默认身份读取，等于越权读取别人 workspace 的会话。
      const forInput = (input: unknown) => {
        const downstream = readTrustedZCodeAgentV4Connection(input);
        if (
          !downstream ||
          downstream.clientMode !== "desktop-continuous" ||
          !agentService ||
          !isConnectionScopableConversationShareService(service)
        ) {
          throw Object.assign(new Error("Conversation sharing connection is not trusted"), {
            kind: "connection_unavailable" as const,
          });
        }
// 四个方法统一用 withTrustedZCodeAgentV4Connection 注入下游身份；
// 参数只透传不重建，避免这里漏掉某个新增字段导致远端看到裁剪过的请求。
        const scopedAgent: ConversationShareAgentService = {
          conversationRowsRangeV4: (params) =>
            agentService.conversationRowsRangeV4(
              withTrustedZCodeAgentV4Connection(params, downstream),
            ),
          conversationFileChangesV4: (params) =>
            agentService.conversationFileChangesV4(
              withTrustedZCodeAgentV4Connection(params, downstream),
            ),
          conversationAttachmentReadV4: (params) =>
            agentService.conversationAttachmentReadV4(
              withTrustedZCodeAgentV4Connection(params, downstream),
            ),
          conversationAttachmentStatV4: (params) =>
            agentService.conversationAttachmentStatV4(
              withTrustedZCodeAgentV4Connection(params, downstream),
            ),
        };
// 作用域化后的 service 与本外观共享存储（进度表、导入去重表），只是换了 Agent 读写通道。
        return service[conversationShareConnectionScopeFactory](scopedAgent);
      };
      return {
        getCapabilities: () => service.getCapabilities(),
// 写操作统一先解出下游身份再委托；注意 forInput 的返回值每次都是新的作用域 service，
// 不能提前算出一次复用——否则第二个请求会带着第一个请求的身份。
        preflight: async (input) => forInput(input).preflight(input),
// operationId 原样透传：进度事件按 operationId 归集，作用域化不能改变它的归属。
        publish: async (input, operationId) => forInput(input).publish(input, operationId),
        onDynamicPublishProgress: (id) => service.onDynamicPublishProgress(id),
// 导入同样需要可信身份：它要读取分享内容并写入 workspace，属于跨边界写操作。
        importShare: async (input, id) => forInput(input).importShare(input, id),
        onDynamicImportProgress: (id) => service.onDynamicImportProgress(id),
        getImportedConversation: (input) => service.getImportedConversation(input),
        getPreview: (code) => service.getPreview(code),
// continuation 走 HTTP + share code 授权，但仍要求连接可信，防止控制端借用 Host 身份拉取内容。
        getContinuation: async (input) => forInput(input).getContinuation(input),
      };
    }
// 兼容分支：service 不具备 Symbol 方法时，退化为「直接改写请求上下文」，
// 适用于测试替身或尚未升级的 Host 实现。
    if (!isConnectionScopableConversationShareService(service)) {
      if (!connection) return service;
      return {
        getCapabilities: () => service.getCapabilities(),
        preflight: (input) =>
          service.preflight(withTrustedZCodeAgentV4Connection(input, connection)),
        publish: (input, id) =>
          service.publish(withTrustedZCodeAgentV4Connection(input, connection), id),
        onDynamicPublishProgress: (id) => service.onDynamicPublishProgress(id),
        importShare: (input, id) =>
          service.importShare(withTrustedZCodeAgentV4Connection(input, connection), id),
        onDynamicImportProgress: (id) => service.onDynamicImportProgress(id),
        getImportedConversation: (input) => service.getImportedConversation(input),
        getPreview: (code) => service.getPreview(code),
        getContinuation: (input) =>
          service.getContinuation(withTrustedZCodeAgentV4Connection(input, connection)),
      };
    }
// 有可信 agentService 但无需再包一层 input 时，直接注入；
// 没有 agentService 说明连接尚未就绪，只能做只读操作。
    if (agentService) return service[conversationShareConnectionScopeFactory](agentService);
// 连接未就绪：发布必须显式失败。若这里放行空实现，UI 会收到「成功但无链接」。
    const rejectUnavailable = async (): Promise<never> => {
      throw Object.assign(new Error("Conversation sharing connection is not ready"), {
        kind: "connection_unavailable" as const,
      });
    };
    return {
      getCapabilities: () => service.getCapabilities(),
      preflight: (input) => service.preflight(input),
      publish: rejectUnavailable,
      onDynamicPublishProgress: (operationId) => service.onDynamicPublishProgress(operationId),
      importShare: (input, operationId) => service.importShare(input, operationId),
      onDynamicImportProgress: (operationId) => service.onDynamicImportProgress(operationId),
      getImportedConversation: (input) => service.getImportedConversation(input),
      getPreview: (shareCode) => service.getPreview(shareCode),
      getContinuation: (input) => service.getContinuation(input),
    };
  }
// 手机远控：没有本地 workspace 副本，也没有发起方身份，全部写操作在入口就拒绝；
// 事件流返回 RpcEvent.None 而不是抛错，避免订阅方在挂载阶段反复报错。
  const rejectMobileShare = async (): Promise<never> => {
    throw Object.assign(new Error("Conversation sharing is only available from Desktop"), {
      kind: "feature_disabled" as const,
    });
  };
  return {
    getCapabilities: () => service.getCapabilities(),
    preflight: rejectMobileShare,
    publish: rejectMobileShare,
    onDynamicPublishProgress: () => RpcEvent.None,
    importShare: rejectMobileShare,
    onDynamicImportProgress: () => RpcEvent.None,
    // 手机远控没有本地 workspace 副本，直接返回 null 即可（不渲染只读块）。
    getImportedConversation: async () => null,
// 预览是纯读、且以 shareCode 为凭据，不涉及 workspace 边界，所以手机端保持可用。
    getPreview: (shareCode: string) => service.getPreview(shareCode),
    getContinuation: rejectMobileShare,
  };
}
