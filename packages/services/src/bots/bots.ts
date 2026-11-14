// bots/bots.ts — IBotsService 契约、Bot 配置/注册/话题相关 DTO 与远控解析接口。
//
// 本文件只声明类型，不含实现；字段口径就是跨层协议，改动需同步 packages/shared
// 与桌面/Web 调用方。
//
// INV-01 可选方法（带 ?）表示“该 Host 不提供此能力”，调用方必须先判存在再调用；
//        不要用“抛未实现错误”代替缺省，会破坏能力探测。
// INV-02 注册类 DTO 的 domain 与 pollDomain 必须同时回传：首次 begin 可能跨域，
//        轮询必须沿用 begin 决定的域。
// INV-03 watchAutomationRun 的 runId 与 sendPrompt.traceId 绑定，用于隔离
//        排队期间的并发轮次。
// [安全] 话题相关接口只传 id 与 workspace 身份，不传原始群信息。
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  ZCodeConfigOption,
  ZCodeProvider,
  BotConfig,
  BotContextState,
  BotInboundMessage,
  BotOutboundMessage,
  BotProvider,
  BotProviderCallbackResult,
  BotServiceStatus,
  BotWorkspaceRef,
  BotsConfigFile,
  ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import type { ZCodeAgentAppRuntimePreferences } from "../zcode-agent/zcodeAgent.js";

// 创建绑定码的参数；botId 为空时由服务端生成新 Bot。
// ttlMs 未给则用 BOT_BIND_CODE_TTL_MS，调用方不要自行复制默认值。
export interface BotCreateBindCodeParams {
  botId?: string;
  allowedWorkspaces?: string[];
  ttlMs?: number;
}

// 保存 Bot；凭据以明文入参传入，由仓储层加密后落盘。
// credentialValue / webhookSecretValue 为空表示“保持原值”，不是清空。
export interface BotSaveBotParams {
  bot: BotConfig;
  credentialValue?: string;
  webhookSecretValue?: string;
}

// 连接测试结果；ok=false 时 message 必须给出可操作原因。
export interface BotTestResult {
  ok: boolean;
  message: string;
  name?: string;
  provider?: BotProvider;
}

// 绑定码与过期时间；code 是一次性凭据，不要写日志。
export interface BotBindCodeResult {
  code: string;
  expiresAt: number;
}

// 列出可选工作区；currentWorkspace 用于把“当前项”排在前面。
export interface BotListWorkspaceRefsParams {
  currentWorkspace?: BotWorkspaceRef;
}

// 与 Bot 当前选择相关的配置项查询；身份优先用 workspaceIdentity。
export interface BotUserConfigOptionsParams {
  workspacePath: string;
  workspaceIdentity?: string;
  provider: ZCodeProvider;
}

// automation 派发前订阅终态；runId 缺省表示订阅该 task 的下一次运行。
export interface BotAutomationRunWatchParams {
  /** 与该次 sendPrompt.traceId 一致，避免排队期间污染其他轮次。 */
  runId?: string;
  target: ZCodeAutomationBotDeliveryTarget;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

// 微信扫码注册的起始信息；qrUrl 供宿主渲染二维码。
// interval/expiresAt 是轮询节奏与二维码失效时间，单位分别为 ms。
export interface BotWeixinRegistrationBeginResult {
  qrCode: string;
  qrUrl: string;
  interval: number;
  expiresAt: number;
}

// 轮询只凭 qrCode，不重复传 Bot 身份。
export interface BotWeixinRegistrationPollParams {
  qrCode: string;
}

// 三态结果：pending/scanned 需继续轮询；success 返回新 botToken；
// expired/error 为终态，error 时 message 需可展示。
export type BotWeixinRegistrationPollResult =
  | {
      status: "pending" | "scanned";
      interval: number;
    }
  | {
      status: "success";
      botToken: string;
      botId?: string;
    }
  | {
      status: "expired" | "error";
      message?: string;
    };

// domain 缺省由服务端决定；返回时回填实际使用的域。
export interface BotFeishuRegistrationBeginParams {
  domain?: "feishu" | "lark";
}

// pollDomain 是后续轮询应使用的域，可能与 domain 不同（跨域注册）。
export interface BotFeishuRegistrationBeginResult {
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  interval: number;
  expiresAt: number;
  domain: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
}

// 轮询必须带上 begin 返回的 domain/pollDomain。
export interface BotFeishuRegistrationPollParams {
  deviceCode: string;
  domain?: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
}

// access_denied 与 expired 都是终态，不能当成 pending 继续轮询。
export type BotFeishuRegistrationPollResult =
  | {
      status: "pending";
      interval: number;
      domain: "feishu" | "lark";
      pollDomain?: "feishu" | "lark";
    }
  | {
      status: "success";
      appId: string;
      appSecret: string;
      domain: "feishu" | "lark";
      appName?: string;
      openId?: string;
    }
  | {
      status: "access_denied" | "expired" | "error";
      message?: string;
      domain: "feishu" | "lark";
    };

// Bot 服务对外契约。实现方必须保证：
// - getConfig/saveConfig 是唯一配置读写入口，其他方法不得直接改配置文件；
// - handleInboundMessage 的副作用只落在 Bot 会话，不得污染桌面本地会话；
// - 带 ? 的方法属于可选能力，Host 不实现时调用方必须降级（见 INV-01）；
// - 所有方法以 botId 为幂等维度，重复调用不能产生第二个任务；
// - 需要 workspace 的方法统一使用 workspaceIdentity 优先的口径；
// - 返回 BotOutboundMessage[] 的顺序即发送顺序，调用方不得重排；
// - 失败必须抛出可分类错误，不要返回空数组冒充“无回复”。
export interface IBotsService {
  replyToChannel?(
    params: import("@zcode/shared").ChannelReplyHostRequest,
  ): Promise<import("@zcode/shared").ChannelReplyResult>;
  validateTopicResource?(
    params: import("#src/bots/topicResource.js").TopicResourceRequest,
  ): Promise<void>;
  readTopicResource?(
    params: import("#src/bots/topicResource.js").TopicResourceRequest,
  ): Promise<import("@zcode/shared").ZCodePromptAttachment>;
  /**
   * 将 App 全局交互偏好同步给 Bot 已持有的远端 runtime；不得为此建立新的远端连接。
   */
  syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
  // 汇总各渠道连接与启用状态；不触发网络探测。
  getStatus(): Promise<BotServiceStatus>;
  // 返回归一化后的配置副本。
  getConfig(): Promise<BotsConfigFile>;
  // 列表只包含当前 Host 可达的工作区。
  listWorkspaceRefs(params?: BotListWorkspaceRefsParams): Promise<BotWorkspaceRef[]>;
  getUserConfigOptions(params: BotUserConfigOptionsParams): Promise<ZCodeConfigOption[]>;
  beginFeishuRegistration(
    params?: BotFeishuRegistrationBeginParams,
  ): Promise<BotFeishuRegistrationBeginResult>;
  pollFeishuRegistration(
    params: BotFeishuRegistrationPollParams,
  ): Promise<BotFeishuRegistrationPollResult>;
  beginWeixinRegistration(): Promise<BotWeixinRegistrationBeginResult>;
  pollWeixinRegistration(
    params: BotWeixinRegistrationPollParams,
  ): Promise<BotWeixinRegistrationPollResult>;
  // 整包保存；返回归一化后的结果。
  saveConfig(config: BotsConfigFile): Promise<BotsConfigFile>;
  // [边界] listBots 返回值不含凭据明文：密钥只经 saveBot 与测试入口使用，UI 与日志拿不到。
  listBots(): Promise<BotConfig[]>;
  saveBot(params: BotSaveBotParams): Promise<BotConfig>;
  removeBotSecret(botId: string): Promise<BotConfig>;
  // 删除配置与运行态；凭据由实现方一并清理。
  deleteBot(botId: string): Promise<void>;
  testBot(botId: string): Promise<BotTestResult>;
  createBindCode(params: BotCreateBindCodeParams): Promise<BotBindCodeResult>;
  getGroupMemberNames?(params: { botId: string; chatId: string }): Promise<Record<string, string>>;
  // 运行态快照用于 UI 展示与诊断。
  getBotStates(): Promise<BotContextState[]>;
  retryTopicPreparation?(params: {
    botId: string;
    chatId: string;
    threadId: string;
    messageId: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
  getTopicDetails?(params: {
    botId: string;
    chatId: string;
    threadId?: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    messageCount: number;
    hasGap: boolean;
    historyEnabled: boolean;
    summaries: Array<{ checkpoint: string; text: string }>;
  }>;

  setGroupEnabled?(params: { botId: string; chatId: string; enabled: boolean }): Promise<void>;
  reconcileGroupResult?(params: {
    botId: string;
    chatId: string;
    deliveryId: string;
    threadId?: string;
    received: boolean;
  }): Promise<import("@zcode/shared").BotGroupDelivery>;
  resendGroupResult?(params: {
    botId: string;
    chatId: string;
    deliveryId: string;
    threadId?: string;
  }): Promise<import("@zcode/shared").BotGroupDelivery>;
  retryPrivateDelivery?(params: { botId: string; deliveryId: string }): Promise<void>;
  resetBotState(contextKey: string): Promise<void>;
  /** 在 automation prompt 派发前订阅终态，并把结果回推到创建它的 Bot 会话。 */
  watchAutomationRun(params: BotAutomationRunWatchParams): Promise<void>;
  handleInboundMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]>;
  handleProviderCallback(provider: BotProvider, payload: unknown): Promise<BotOutboundMessage[]>;
  handleProviderCallbackResponse(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
}

// RPC 描述符：频道名固定，改动等于破坏线协议。
// 类型与运行时描述符同名导出，import 时注意 type-only。
export const IBotsService = createServiceDescriptor<IBotsService>(ServiceChannels.Bots);

/** Host 负责把旧线路身份解析到当前 Source；不允许 services 猜测连接目录。 */
// Host 把旧线路身份解析成当前 Source 的结果。
// workspaceIdentity 必填：远程去重与 attachment 换代都以身份为准，不能只比路径。
// runtimeKey 只在当前窗口存在在线 logical session 时返回，用于隔离换代连接。
// 解析失败返回 null，由调用方决定提示重连还是新建连接。
export interface BotRemoteWorkspaceResolution {
  workspacePath: string;
  workspaceIdentity: string;
  target: import("@zcode/shared").RemoteTarget;
  /** 只有当前窗口存在在线 logical session 才有值，用于 attachment 换代隔离。 */
  runtimeKey?: string;
}
// purpose=lookup 用于普通查找，reconnect 允许触发重连；
// 实现方不得在 lookup 阶段建立新连接。
// 返回 null 表示当前没有可用 Source，不是“再试一次”。
export type BotRemoteWorkspaceResolver = (
  workspace: { workspacePath: string; workspaceIdentity: string },
  purpose: "lookup" | "reconnect",
) => Promise<BotRemoteWorkspaceResolution | null>;
