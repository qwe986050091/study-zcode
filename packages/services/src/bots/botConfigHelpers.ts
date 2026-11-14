// bots/botConfigHelpers.ts — Bot 配置的查找、归一化与命令授权判定。
//
// INV-01 findAuthorizedBot 按渠道分流：飞书/群聊必须匹配 botId，微信按 botId，
//        其余 provider 按 providerUserId；三者不可合并，否则群消息会被私聊绑定
//        关系误判为已授权。
// INV-02 allowedWorkspaces 是唯一 workspace 权限边界；空数组必须归一化为全部
//        允许，任何“空即拒绝”的推断都会让存量 Bot 升级后失权。
// INV-03 normalizeBotConfig 必须清理微信配置里的 webhookUrl，避免旧字段继续
//        被当成出站目标。
// INV-04 未配置的命令默认放行（!== false）；改写成 === true 会让所有存量 Bot
//        升级后命令全部失效。
import {
  normalizeBotReplyGranularity,
  type BotActor,
  type BotCommandPolicy,
  type BotConfig,
  type BotProvider,
  type BotsConfigFile,
} from "@zcode/shared";
import { normalizeBotCommandPolicy, normalizeBotCurrentOptions } from "./config.js";
import { normalizeAllowedWorkspaces } from "./workspaceHelpers.js";

// 仅用于外部 JSON 的宽松探测；不做完整 schema 校验。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// contextKey 目前等于 botId；独立成函数是为了保留后续多实例扩展点。
export function getContextKey(bot: Pick<BotConfig, "id">): string {
  return bot.id;
}

// 仅按 id 查找，不附加启用状态；启用判断由调用方负责。
export function findBot(config: BotsConfigFile, botId: string): BotConfig | null {
  return config.bots.find((bot) => bot.id === botId) ?? null;
}

// 回调归属解析：优先 payload.botId，其次同渠道首个启用 Bot。
export function findCallbackBot(
  config: BotsConfigFile,
  provider: BotProvider,
  payload: unknown,
): BotConfig | null {
  // 平台回调 payload 不可信；非对象直接视为未知 Bot。
  if (!isRecord(payload)) {
    return null;
  }
  // 非字符串 botId 一律忽略，避免把数字等值当成 id。
  const botId = typeof payload.botId === "string" ? payload.botId : "";
  // 显式 botId 优先；查不到不回落到同渠道第一个 Bot，避免串号。
  if (botId) {
    return findBot(config, botId);
  }
  // 无 botId 的旧回调只能按渠道兜底到第一个启用 Bot。
  return config.bots.filter((bot) => bot.provider === provider && bot.enabled).at(0) ?? null;
}

// 入站鉴权：只有 enabled 且身份匹配的 Bot 才允许接收消息。
export function findAuthorizedBot(config: BotsConfigFile, actor: BotActor): BotConfig | null {
  // 群聊必须精确匹配 botId，不能按发送人绑定关系推断。
  if (actor.chatType === "group" && (actor.provider === "feishu" || actor.provider === "lark")) {
    return (
      config.bots.find(
        (bot) => bot.enabled && bot.id === actor.botId && bot.provider === actor.provider,
      ) ?? null
    );
  }
  // 微信没有 providerUserId 绑定语义，只认 botId。
  if (actor.provider === "weixin") {
    return (
      config.bots.find(
        (bot) => bot.enabled && bot.provider === "weixin" && bot.id === actor.botId,
      ) ?? null
    );
  }
  return (
    config.bots.find(
      (bot) =>
        bot.enabled &&
        bot.provider === actor.provider &&
        bot.providerUserId === actor.providerUserId,
    ) ?? null
  );
}

export function findBoundUser(bot: BotConfig, actor: BotActor): BotConfig | null {
// 绑定判定：微信天然绑定到 Bot 本身，其他渠道比对绑定用户。
  return actor.provider === "weixin" || bot.providerUserId === actor.providerUserId ? bot : null;
}

// 持久化前的归一化；幂等，可重复调用。
export function normalizeBotConfig(bot: BotConfig): BotConfig {
  // 一次性归一化所有持久化字段；返回值可直接写回配置文件。
  const normalized = {
    ...bot,
    // Bot 配置化后 allowedWorkspaces 是唯一 workspace 权限边界；空数组统一落成 "*"。
    allowedWorkspaces: normalizeAllowedWorkspaces(bot.allowedWorkspaces),
    allowedCommands: normalizeBotCommandPolicy(bot.allowedCommands),
    currentOptions: normalizeBotCurrentOptions(bot.currentOptions),
    // Bugfix: Feishu/Lark 的回复颗粒度依赖 Card JSON 2.0 单卡更新，旧配置不能继续保留普通消息模式。
    replyMode: normalizeBotReplyGranularity(bot.provider, bot.replyMode),
  };
  // 只有微信强制清理 webhookUrl；其他渠道依赖该字段出站。
  if (normalized.provider !== "weixin") {
    return normalized;
  }
  // 微信使用内置 iLink 地址，保存时清理 webhookUrl，避免把其他 provider 的出站字段残留到微信配置。
  delete normalized.webhookUrl;
  return normalized;
}

// 每次判定前重新归一化，兼容旧配置缺字段。
function getUserCommandPolicy(bot: BotConfig): BotCommandPolicy {
  return normalizeBotCommandPolicy(bot.allowedCommands);
}

// 命令授权入口；调用方必须传入解析后的命令名，不要传原始文本。
export function isUserCommandAllowed(
  bot: BotConfig,
  requestedCommand:
    | "help"
    | "status"
    | "new"
    | "reconnect"
    | "workspace"
    | "model"
    | "mode"
    | "thoughtLevel"
    | "task"
    | "reply"
    | "stop"
    | "message"
    | "approve",
): boolean {
  if (
    // help/message/approve/task/stop 属于安全与可用性下限，不受命令策略限制。
    requestedCommand === "help" ||
    requestedCommand === "message" ||
    requestedCommand === "approve" ||
    requestedCommand === "task" ||
    requestedCommand === "stop"
  ) {
    return true;
  }
  // reconnect 复用 workspace 开关：重连的前提是允许切换工作区。
  if (requestedCommand === "reconnect") {
    return getUserCommandPolicy(bot).workspace !== false;
  }
  // 未显式关闭即放行，保持旧配置升级后的可用性（见 INV-04）。
  return getUserCommandPolicy(bot)[requestedCommand] !== false;
}

// 批量归一化入口；保持 version 等其他顶层字段不变。
export function normalizeConfigBots(config: BotsConfigFile): BotsConfigFile {
  return {
    ...config,
    // 逐 Bot 归一化，顺序保持不变。
    bots: config.bots.map(normalizeBotConfig),
  };
}
