// bots/topicResource.ts — 话题历史附件按索引的授权读取。
//
// INV-01 授权必须从“已接收输入”反查：用 inputId 找到唯一 accepted 输入，
//        再比对 taskId/workspace 身份，绝不采信模型给出的群/消息 id。
// INV-02 授权身份 identity 是下载前后各校验一次的凭证；任一次变化（停用、
//        换绑、关闭历史）都必须中止，不能返回已下载内容。
// INV-03 原生消息的 messageId/chatId/threadId 必须与授权目标完全一致，
//        且不能是已删除消息。
// INV-04 附件索引必须是安全整数且存在，且大小不超过协议上限。
// [安全] 历史开关 parent.historyEnabled === false 时整条链路拒绝。
import type {
  BotConfig,
  BotInboundAttachment,
  BotsConfigFile,
  BotsStateFile,
  ZCodeProtocolTrace,
} from "@zcode/shared";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";

// 读取请求；resourceIndex 缺省为 0（该消息的第一个附件）。
export interface TopicResourceRequest {
  taskId: string;
  inputId: string;
  messageId: string;
  authorizationId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  resourceIndex?: number;
  signal?: AbortSignal;
  trace?: ZCodeProtocolTrace;
  remoteSessionId?: string;
}

// 从平台读回的原生消息投影；deleted 表示平台侧已删除。
export interface TopicResourceMessage {
  messageId: string;
  chatId: string;
  threadId: string;
  deleted?: boolean;
  attachments: BotInboundAttachment[];
}

// 依赖注入：state/config 用于鉴权，readMessage/download 由渠道适配层提供。
export interface TopicResourceDependencies {
  readState(): Promise<BotsStateFile>;
  readConfig(): Promise<BotsConfigFile>;
  // 由渠道适配层实现：按授权目标回读平台消息。
  readMessage(
    bot: BotConfig,
    target: { messageId: string; chatId: string; threadId: string },
    signal?: AbortSignal,
  ): Promise<TopicResourceMessage>;
  // 由渠道适配层实现：下载单个附件并返回字节。
  download(
    bot: BotConfig,
    attachment: BotInboundAttachment,
    target: { messageId: string; chatId: string; threadId: string },
    signal?: AbortSignal,
  ): Promise<{ attachment: BotInboundAttachment; data: Uint8Array }>;
}

/** 历史附件此前只有文字占位；下载必须从已接收输入反查身份，不能相信模型提供的群信息。 */
// 主入口：鉴权 → 读原生消息 → 范围校验 → 下载 → 二次鉴权 → 大小校验。
export async function readAuthorizedTopicResource(
  request: TopicResourceRequest,
  deps: TopicResourceDependencies,
): Promise<{ attachment: BotInboundAttachment; data: Uint8Array }> {
  // [契约] authorize 闭包固定同一套 request/deps：前后两次鉴权必须走同一实现，第二次只用于确认下载期间权限未被收回。
  const authorize = () => authorizeTopicResource(request, deps);

  // 第一次授权确定 bot/target/identity，后续所有 I/O 都基于它。
  const initial = await authorize();
  // 以授权目标去读原生消息，而不是用请求里的 messageId 直接读。
  const native = await deps.readMessage(initial.bot, initial.target, request.signal);
  if (
    native.messageId !== initial.target.messageId ||
    native.chatId !== initial.target.chatId ||
    native.threadId !== initial.target.threadId ||
    native.deleted
  )
    // 三重 id 任一不符即拒绝（见 INV-03）。
    throw new Error("Topic resource native scope mismatch");
  // 索引口径：同一消息内 0 基下标。
  const index = request.resourceIndex ?? 0;
    // 索引非法或越界一律失败，不做回退到 0。
  if (!Number.isSafeInteger(index) || index < 0 || !native.attachments[index])
    throw new Error("Topic resource index unavailable");
  // 二次授权检查；只比较 identity，避免重复拉全量配置。
  const check = async () => {
    // 停用、换绑及历史开关可能在 I/O 期间变化，旧请求不能在下载后继续暴露内容。
    if ((await authorize()).identity !== initial.identity)
      throw new Error("Topic resource authorization changed");
  };
  await check();
  // 下载后再校验一次，覆盖 I/O 期间配置变化。
  const result = await deps.download(
    initial.bot,
    native.attachments[index]!,
    initial.target,
    request.signal,
  );
  await check();
    // 与协议附件上限同一口径，超限即失败。
  if (result.data.byteLength > PROTOCOL_V4_LIMITS.attachmentMaxBytes)
    throw new Error("Topic resource exceeds attachment size limit");
  return result;
}

// 纯鉴权：返回当前有效身份；不产生下载副作用。
export async function authorizeTopicResource(
  request: TopicResourceRequest,
  deps: Pick<TopicResourceDependencies, "readState" | "readConfig">,
) {
  // 入口先响应取消，避免无谓的文件读取。
  request.signal?.throwIfAborted();
  // state 与 config 并行读取；两者都是锁内快照。
  const [state, config] = await Promise.all([deps.readState(), deps.readConfig()]);
  const matches = Object.values(state.bots).filter((context) => {
    const input = context.group?.inputs?.[request.inputId];
    return (
      context.activeTaskId === request.taskId &&
      input?.taskId === request.taskId &&
      input.admission === "accepted" &&
      (context.workspaceIdentity?.trim() || context.workspacePath) ===
        (request.workspaceIdentity?.trim() || request.workspacePath)
    );
  });
  // 必须唯一命中：多命中说明 inputId 被跨 task 复用，视为越权。
  if (matches.length !== 1) throw new Error("Topic resource task scope unavailable");
  const context = matches[0]!;
  // 命中 accepted 输入即保证 group/inputs 存在。
  const group = context.group!;
  // source 记录消息来自哪个群/话题，是后续范围校验的基准。
  const source = group.inputs![request.inputId]!.source;
  // Bot 从配置侧取，运行态只提供 botId。
  const bot = config.bots.find((candidate) => candidate.id === context.botId);
  // 找同群的父会话（无 threadId 的那条运行态）。
  const parents = Object.values(state.bots).filter(
    (candidate) =>
      candidate.botId === context.botId &&
      candidate.group?.chatId === group.chatId &&
      !candidate.group.threadId,
  );
  // 群父会话用于历史开关；不唯一时视为无父会话。
  const parent = parents.length === 1 ? parents[0]!.group : undefined;
  if (
    // Bot 必须启用且是飞书/Lark，话题历史仅这两类渠道支持。
    !bot?.enabled ||
    (bot.provider !== "feishu" && bot.provider !== "lark") ||
    // 群会话与会话历史都必须开启。
    !group.enabled ||
    !parent?.enabled ||
    parent.historyEnabled === false ||
    !request.authorizationId ||
    group.authorizationId !== request.authorizationId ||
    parent.authorizationId !== request.authorizationId ||
    // owner 必须是 Bot 自身，避免以他人身份读取历史。
    group.ownerId !== bot.providerUserId ||
    parent.ownerId !== bot.providerUserId ||
    source.botId !== bot.id ||
    source.authorizationId !== request.authorizationId ||
    source.provider !== bot.provider ||
    source.chatId !== group.chatId ||
    // 话题授权必须绑定到具体 threadId。
    !source.threadId ||
    // 源消息必须属于该话题；父群消息不能借话题授权读取。
    (group.threadId && source.threadId !== group.threadId)
  )
    // 任一开关/绑定/授权 id 不一致都拒绝，见 INV-04 与 INV-01。
    throw new Error("Topic resource authorization unavailable");

  // 最后确认目标消息确在本次 task 的已接收归档中。
  const archived = Object.values(group.inputs ?? {}).some(
    (input) =>
      input.admission === "accepted" &&
      input.taskId === request.taskId &&
      input.source.botId === bot.id &&
      input.source.chatId === group.chatId &&
      input.source.threadId === source.threadId &&
        // 归档里的 topicContext 才是消息白名单。
      input.source.topicContext?.messages.some(
        (record) =>
          // 三重范围 + 未删除 + 受支持类型，缺一不可。
          record.id === request.messageId &&
          record.chatId === group.chatId &&
          record.threadId === source.threadId &&
          !record.deleted &&
          ["file", "image", "post"].includes(record.kind),
      ),
  );
  // 不在归档内说明该消息从未被此 task 接收，直接拒绝。
  if (!archived) throw new Error("Topic resource is not in this task's admitted archive");
  return {
    bot,
    // 下载目标使用群内 threadId，而不是请求里可能缺失的值。
    target: { messageId: request.messageId, chatId: group.chatId, threadId: source.threadId },
    // identity 字段顺序即指纹口径，改动会让旧校验失效。
    identity: JSON.stringify([
      bot.id,
      bot.provider,
      bot.providerUserId,
      bot.credentialRef,
      bot.feishuAppId,
      group.chatId,
      source.threadId,
      group.authorizationId,
    ]),
  };
}
