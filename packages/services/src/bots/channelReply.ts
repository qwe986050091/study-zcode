// bots/channelReply.ts — Bot 通过渠道原生回复工具回发消息的授权与幂等入口。
//
// INV-01 发送目标只能来自“任务唯一绑定”的运行态：遍历 state.bots 过滤
//        activeTaskId + workspace + 唯一性；多命中直接失败，不做兜底。
// INV-02 输入来源不是发送授权：必须重新校验 bot/group/authorizationId 与
//        每条 accepted 输入的 source 身份，任一变化即拒绝。
// INV-03 幂等键 = sha256(botId, taskId, inputId, toolCallId)；请求内容哈希不同
//        视为冲突，不能复用旧 delivery。
// INV-04 unknown 是崩溃恢复标记，不是可自由重试的状态；重放必须交给投递
//        owner，不能另建重试队列。
// INV-05 外部目录查询期间授权可能变化：查询后必须重新 readBinding 并比对
//        scope / sourceCommandId / messageId。
// INV-06 回复正文 1–2000 字符，且所有 channelMention 必须属于当前 provider。
// [安全] 只接受 accepted 且未被取消/丢弃/停止的输入作为锚点。
import { resolveChannelMentionNames } from "#src/bots/channelMentionResolver.js";
import { createHash } from "node:crypto";
import {
  channelReplyHostRequestSchema,
  channelContentText,
  resolveChannelReplyParts,
  type ChannelReplyHostRequest,
  type ChannelReplyResult,
  type BotsStateFile,
  type BotsConfigFile,
  type BotConfig,
  type BotGroupDelivery,
} from "@zcode/shared";

// 依赖注入：状态/配置读取、群成员目录、投递全部外部化。
interface ChannelReplyDependencies {
  readState(): Promise<BotsStateFile>;
  readConfig(): Promise<BotsConfigFile>;
  listMembers?(bot: BotConfig, chatId: string): Promise<Record<string, string>>;
  deliver(
    bot: BotConfig,
    chatId: string,
    threadId: string | undefined,
    result: BotGroupDelivery,
  ): Promise<void>;
}

// 解析并校验唯一的任务-渠道绑定；返回发送所需的全部可信信息。
async function readBinding(request: ChannelReplyHostRequest, deps: ChannelReplyDependencies) {
  // 并行读取，二者都是锁内快照。
  const [state, config] = await Promise.all([deps.readState(), deps.readConfig()]);
  // 三重条件：activeTaskId、workspace 身份、必须存在 group 会话。
  const matches = Object.entries(state.bots).filter(
    ([, context]) =>
      context.activeTaskId === request.taskId &&
      context.workspacePath === request.workspacePath &&
      (context.workspaceIdentity?.trim() || context.workspacePath) ===
        (request.workspaceIdentity?.trim() || request.workspacePath) &&
      Boolean(context.group),
  );
  // 不唯一即失败：宁可报错也不能发到猜测的群（见 INV-01）。
  if (matches.length !== 1)
    throw new Error(
      "Channel reply requires exactly one active task channel binding; do not retry without restoring the binding",
    );
  // key 是 state.bots 的键，后续写回 delivery 要用。
  const [key, context] = matches[0]!;
  // 前面已过滤 Boolean(context.group)，这里可安全断言。
  const group = context.group!;
  // Bot 从配置侧取，运行态只提供 botId。
  const bot = config.bots.find((candidate) => candidate.id === context.botId);
  if (
    // if (!bot?.enabled || ...) 中任一项不满足都视为授权已变更，直接返回 stale。
    !bot?.enabled ||
    !group.enabled ||
    group.ownerId !== bot.providerUserId ||
    !group.authorizationId ||
    (request.authorizationId !== undefined && group.authorizationId !== request.authorizationId) ||
    // 话题已退出时不能再向该话题发送。
    group.topicActive === false
  )
  // 统一错误文案，避免向模型泄漏具体失效原因。
    throw new Error("Channel reply authorization changed");
  // 输入来源不是发送授权：从任务唯一绑定中解析可信目标，禁止拿另一任务/旧授权兜底。
  // 原生输入白名单：必须与 Bot/群/授权完全一致（见 INV-02）。
  const nativeInputs = Object.entries(group.inputs ?? {}).filter(([, input]) => {
    const source = input.source;
    return (
      // 只认 accepted；pending 材料尚未授权发送。
      input.admission === "accepted" &&
      // appId 必须同时存在且匹配，空值不能通过。
      source.appId === bot.feishuAppId &&
      Boolean(source.appId) &&
      source.botId === bot.id &&
      source.provider === bot.provider &&
      source.chatId === group.chatId &&
      source.threadId === group.threadId &&
      source.authorizationId === group.authorizationId
    );
  });
  // 排除已取消/丢弃/停止的输入，它们不能再作为发送锚点。
  const eligible = nativeInputs.filter(
    ([, input]) =>
      input.taskId === request.taskId &&
      !["cancelled", "discarded", "stopped"].includes(input.progress?.status ?? ""),
  );
  // 原生身份不随任务切换失效；历史节点只作为名字候选，不能扩大当前发送 ref 的授权。
  // 名字候选只用于解析，不扩大发送 ref 的授权范围。
  const nameCandidates = nativeInputs.flatMap(
    ([, { source }]) =>
      source.messages?.flatMap((message) => message.contentParts ?? []) ??
      source.contentParts ??
      [],
  );
  // 显式 inputId 必须仍在该任务的可发送集合内。
  const current = group.inputs?.[request.inputId];
  if (current && !eligible.some(([id]) => id === request.inputId))
    throw new Error("Channel reply execution input is no longer authorized");
  // 优先请求指定的输入，否则用最近一条。
  const anchor = eligible.find(([id]) => id === request.inputId) ?? eligible.at(-1);
  // 没有任何可用原生上下文时直接失败，禁止无锚点发送。
  if (!anchor)
    throw new Error(
      "Channel reply has no valid native conversation context; do not retry unchanged",
    );
  // 锚点决定 replyToMessageId 与 threadId。
  const [sourceCommandId, { source }] = anchor;
  // trusted 是全部可发送输入里的可信节点，用于解析 mention ref。
  const trusted = eligible.flatMap(
    ([, { source }]) =>
      source.messages?.flatMap((message) => message.contentParts ?? []) ??
      source.contentParts ??
      [],
  );
  // scope 参与 mention ref 的哈希，隔离不同任务/授权下的目标。
  const scope = JSON.stringify([
    key,
    request.taskId,
    context.workspaceIdentity?.trim() || context.workspacePath,
    bot.id,
    bot.provider,
    bot.feishuAppId,
    bot.credentialRef,
    bot.providerUserId,
    group.authorizationId,
  ]);
  // 一次性返回，调用方不再二次读取状态。
  return { key, group, bot, source, sourceCommandId, trusted, nameCandidates, scope };
}

// 把落盘 delivery 映射成对外结果；未知状态一律 unknown。
function receipt(saved: BotGroupDelivery | undefined, id: string): ChannelReplyResult {
  return {
    status:
      saved?.status === "sent" || saved?.status === "failed" || saved?.status === "invalidated"
        ? saved.status
        : "unknown",
    // deliveryId 与幂等 id 相同，便于调用方回查。
    deliveryId: id,
    ...(saved?.providerMessageId ? { providerMessageId: saved.providerMessageId } : {}),
    // 错误只回传摘要文本，不回传堆栈。
    ...(saved?.lastError ? { error: saved.lastError } : {}),
  };
}

// 主入口：校验 → 幂等重放 → 解析 mention → 投递 → 回读结果。
export async function replyToBotChannel(
  value: ChannelReplyHostRequest,
  deps: ChannelReplyDependencies,
): Promise<ChannelReplyResult> {
  // 入参先过 schema；非法请求不进入任何授权分支。
  const request = channelReplyHostRequestSchema.parse(value);
  // binding 可能因目录查询刷新，后续统一读最新值。
  let binding = await readBinding(request, deps);
  const { bot } = binding;
  // 幂等 id 只由四个稳定身份组成（见 INV-03）。
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        "channel-reply",
        bot.id,
        request.taskId,
        request.inputId,
        request.toolCallId,
      ]),
    )
    .digest("hex");
  // 内容哈希：文本、ref 或 name+candidateRef，用于检测同 id 不同内容。
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify(
        request.parts.map((part) =>
          part.type === "text"
            ? [part.type, part.text]
            : part.type === "mention"
              ? [part.type, part.refId]
              : [part.type, part.name, part.candidateRef ?? null],
        ),
      ),
    )
    .digest("hex");
  // 重放：同请求直接返回回执，不同请求判冲突。
  const replay = async (saved: BotGroupDelivery | undefined) => {
    // 没有请求哈希说明是旧记录，交给正常投递流程。
    if (!saved?.channelReplyRequestHash) return undefined;
      // 同 id 不同内容属于调用方错误，必须暴露。
    if (saved.channelReplyRequestHash !== requestHash)
      throw new Error("Channel reply idempotency conflict");
    // unknown 是崩溃恢复标记，不代表活跃发送已结束；复用投递 owner 等待，
    // 无活跃发送的持久记录由 owner 保持不重发，不能另建重试队列。
      // 未终态交给投递 owner 处理（见 INV-04）。
    if (saved.status !== "sent" && saved.status !== "invalidated") {
      await deps.deliver(bot, binding.group.chatId, binding.group.threadId, saved);
      saved = (await deps.readState()).bots[binding.key]?.group?.deliveries?.[id];
    }
    return receipt(saved, id);
  };
  // 首次重放检查：已有终态直接返回。
  const previous = await replay(binding.group.deliveries?.[id]);
  if (previous) return previous;
  let parts;
  // 只有飞书/Lark 支持按名字解析 @。
  if (request.parts.some((part) => part.type === "mentionName")) {
    // 其他渠道收到 mentionName 属于协议误用。
    if (bot.provider !== "feishu" && bot.provider !== "lark")
      throw new Error("Unsupported mention channel");
    let members: Record<string, string> | undefined;
    try {
      // 目录失败不阻断：解析器会返回可解释的澄清结果。
      members = await deps.listMembers?.(bot, binding.group.chatId);
    } catch {
      /* 目录失败作为可解释的待澄清结果，不暴露不完整名单。 */
    }
    // 外部查询期间可能停用/换绑或停止执行；查询结果绝不能延续旧授权。
    // 查询后重新鉴权（见 INV-05）。
    const fresh = await readBinding(request, deps);
    if (
      // scope 变化说明授权或身份已变。
      fresh.scope !== binding.scope ||
      fresh.sourceCommandId !== binding.sourceCommandId ||
      fresh.source.messageId !== binding.source.messageId
    )
      // 此时不能再使用查询前的任何结果。
      throw new Error("Channel reply authorization changed during lookup");
    binding = fresh;
    // 查询期间可能已被并发请求完成，binding 返回 fresh 前必须再查一次 replay。
    const concurrent = await replay(binding.group.deliveries?.[id]);
    if (concurrent) return concurrent;
    // 解析结果要么是 parts，要么是澄清，二者互斥。
    const resolved = resolveChannelMentionNames(
      request.parts,
      binding.trusted,
      members,
      binding.scope,
      bot.provider,
      binding.nameCandidates,
    );
    // 澄清直接返回，不进入投递。
    if ("status" in resolved) return resolved;
    parts = resolved.parts;
  // 无名字时按可信 ref 解析。
  } else parts = resolveChannelReplyParts(request.parts, binding.trusted);
  // 跨渠道 mention 一律拒绝（见 INV-06）。
  if (parts.some((part) => part.type === "channelMention" && part.channel !== bot.provider))
    throw new Error("Channel mention provider mismatch");
  // channelContentText(parts) 为空或超过 2000 字时必须在发送前拦截，避免空消息入频道。
  if (!channelContentText(parts).trim() || channelContentText(parts).length > 2000)
    throw new Error("Channel reply must contain 1–2000 characters");
  const { group, source, sourceCommandId, key } = binding;
  // 已存在同 id 记录时，内容必须完全一致。
  const existing = group.deliveries?.[id];
    // 内容不一致即幂等冲突。
  if (existing && JSON.stringify(existing.contentParts) !== JSON.stringify(parts))
    throw new Error("Channel reply idempotency conflict");
  // 投递记录一次性写全所有发送字段。
  await deps.deliver(bot, group.chatId, group.threadId, {
    id,
    channelReplyRequestHash: requestHash,
    appId: source.appId,
    trace: request.trace,
    authorizationId: group.authorizationId,
    taskId: request.taskId,
    sourceCommandId,
    text: channelContentText(parts),
    contentParts: parts,
    replyToMessageId: source.messageId,
    threadId: source.threadId,
    rootMessageId: source.rootMessageId,
    status: "pending",
    updatedAt: Date.now(),
  });
  // 回读投递结果，避免用内存态猜测。
  const saved = (await deps.readState()).bots[key]?.group?.deliveries?.[id];
  // 回读内容不一致同样判冲突。
  if (saved && JSON.stringify(saved.contentParts) !== JSON.stringify(parts))
    throw new Error("Channel reply idempotency conflict");
  return receipt(saved, id);
}
