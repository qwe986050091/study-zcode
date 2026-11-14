// ============================================================================
// 文件头：职责边界与不变量（INV）
// ============================================================================
//
// 【职责边界】
// - 只定义 Bot 的共享协议形状、zod 校验与归一函数；不实现消息收发、路由、
//   持久化 IO，也不做权限判定。运行时行为在 Host/Bot service，写到这里即越界。
// - 同时是 bot-config.json / bots-state.json 的解析契约：字段改名或收紧校验，
//   等于直接改变磁盘上历史文件的可用性。
//
// 【不变量 INV】
// INV-01 botProviders 是持久化配置的解析白名单，只增不删；删条目会让旧配置整体
//   解析失败（botProviders 被 botConfigSchema.provider 引用），全部 Bot 停摆。
// INV-02 所有 schema 必须保持 .strict()；放宽会在配置里留下无人读取的字段，
//   且这些字段在下一次写回时静默丢失，用户以为设置已保存。
// INV-03 BotConfig/BotState 的 version 与 schema 的 z.literal(3) 必须同步；
//   只改一侧会让整份文件 parse 失败，Bot 无法启动。
// INV-04 legacyBotAgentProviderSchema 只做历史值归一、不做合法性拒绝；
//   收紧成 literal 会让带 codex/claude 等历史值的旧状态文件全部解析失败。
// INV-05 botGroupInputSourceSchema 的 superRefine 三条 scope 校验必须保留；
//   移除后跨话题/跨群的 messages、topicHistory、topicContext 会被静默接受。
// INV-06 mentionedBot、senderType、botOpenId 只能来自 Provider 校验结果；
//   改成从正文解析，等于允许用户伪造 @机器人 或伪造机器人身份提权。
// INV-07 BotActor 的 providerUserId/chatId 是路由键，不得由展示名反推；
//   展示名可变，用展示名路由会把消息投给错误的人。
// INV-08 botGroupDeliverySchema.channelReplyRequestHash 是请求指纹，必须保留；
//   去掉后重试会重新解析名字，目录变化时回执可能发给另一个人。
// INV-09 projectId 的 undefined 与 null 语义不同：undefined 表示旧状态待交接，
//   null 表示明确不属于任何项目；合并两者会让旧目录被再次自动归入。
// INV-10 privateBindingId 是单聊绑定代际，必须随换绑更新；删除后迟到的旧事件
//   会恢复已断开的绑定，造成串话。
// INV-11 消息/附件数组上限（200、201、1000）是内存与卡片渲染边界，不得放宽；
//   放宽后单条入站就能把上下文和卡片撑爆。
// INV-12 DEFAULT_BOT_COMMANDS 是新建 Bot 的权限基线；改动等于批量改变存量
//   Bot 的可用命令，属于行为变更而非重构。
// INV-13 streaming_card 仅在 Feishu/Lark 可用；放开到其他渠道会发出无法更新的
//   卡片消息，用户看到永远停在中间态。
// INV-14 BOT_TASK_BROADCAST_CHANNEL 等频道常量是跨进程协议值，不得改名；
//   改名后已连接的 Renderer/Host 收不到事件且无报错。
// INV-15 字段只增不改名、不复用旧名；跨版本的 Host 与 CLI 需要同时可解析同一份
//   状态文件，重命名等于破坏前向/后向兼容。
// INV-16 归一函数必须永不抛错并总返回受支持值；normalizeBotReplyGranularity 的
//   supported[0] 兜底是最后防线，删掉会让未知配置直接崩溃。
import { zcodeProtocolTraceSchema, type ZCodeProtocolTrace } from "./zcode-protocol/trace.js";
import { channelContentPartsSchema, type ChannelContentPart } from "./channel-mention.js";
/* oxlint-disable eslint(max-lines) -- Bot 共享合约集中维护 provider、状态和 schema，保持类型与校验就近。 */
import { z } from "zod";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";
import { conversationQuotesSchema } from "./conversationSelection.js";
import { ZCODE_AGENT_PROVIDER, ZCODE_AGENT_PROVIDER_LABEL } from "./zcode-agent-policy.js";
import type {
  ZCodeConfigOption,
  ZCodeElicitationRequest,
  ZCodeElicitationQuestion,
  ZCodePermissionRequest,
  ZCodePromptAttachment,
  ZCodeProvider,
  ZCodeStreamEvent,
  ZCodeTaskMeta,
  ZCodeTaskRuntimeStatus,
} from "./zcode-task-types-core.js";
import {
  zcodeInteractionRequestOriginSchema,
  zcodePermissionResponseSchema,
  type ZCodeInteractionRequestOrigin,
  type ZCodePermissionResponse,
} from "./zcode-protocol-legacy-types.js";
import type { Locale } from "./protocol.js";

// [契约] 这里是 provider 的唯一枚举来源：BotProvider 类型、botConfigSchema 的
// provider 校验都从它派生，新增渠道只改这一处即可联动。
// 顺序参与 z.enum 的错误信息与 UI 展示，调整顺序属于可见变更。
// 删除任何一项都会让已落盘的 Bot 配置无法再次解析。
export const botProviders = [
  "telegram",
  "webhook",
  "feishu",
  "lark",
  "weixin",
  "discord",
  "wecom",
] as const;

export type BotProvider = (typeof botProviders)[number];
export type FeishuBotProvider = Extract<BotProvider, "feishu" | "lark">;

/**
 * 定时任务完成后的 Bot 回推目标。只保留未来仍稳定的会话地址；当前消息 id/context token
 * 属于一次入站交互，不能持久化后复用。该字段由 Host 注入，模型工具参数不直接暴露。
 */
// [契约] 只保存跨会话仍有效的地址（provider/botId/providerUserId/chatType），
// 刻意不含 messageId、context token 等一次性字段。
// [失败路径] 把这些一次性字段写进定时任务，任务在下一次触发时会带着过期 token
// 投递并失败；失败点离原因很远，排查成本极高。
// 该目标由 Host 注入，模型工具参数不直接暴露，避免模型自行指定投递对象。
export const zcodeAutomationBotDeliveryTargetSchema = z
  .object({
    provider: z.enum(["feishu", "lark", "weixin"]),
    botId: z.string().trim().min(1),
    providerUserId: z.string().trim().min(1),
    chatType: z.enum(["private", "group"]),
    threadId: z.string().min(1).optional(),
    rootMessageId: z.string().min(1).optional(),
  })
  .strict();

export type ZCodeAutomationBotDeliveryTarget = z.infer<
  typeof zcodeAutomationBotDeliveryTargetSchema
>;

// [契约] 类型守卫把 feishu|lark 收敛成一个能力集合；调用方据此决定卡片、
// 话题历史等 Feishu 专属能力是否可用。
// 新增飞书系别名时必须同时扩展 FeishuBotProvider，否则守卫返回 false，
// 能力被静默降级且没有报错。
export function isFeishuBotProvider(provider: BotProvider): provider is FeishuBotProvider {
  return provider === "feishu" || provider === "lark";
}
export type BotContextMode = "draft" | "task";
export type BotReplyGranularity =
  | "assistant_changes"
  | "assistant_toolcalls_changes"
  | "summary_changes"
  | "streaming_card";

// [契约] 这是「所有渠道理论上支持」的全集，实际可用子集由
// getSupportedBotReplyGranularities 按渠道裁剪，两者不可合并。
// as const satisfies 保证字面量类型与 BotReplyGranularity 双向校验，
// 新增粒度时漏改联合类型会在这里编译失败，而不是运行时静默丢弃。
export const BOT_REPLY_GRANULARITIES = [
  "assistant_changes",
  "assistant_toolcalls_changes",
  "summary_changes",
  "streaming_card",
] as const satisfies readonly BotReplyGranularity[];

// [契约] "*" 是 allowedWorkspaces 的通配哨兵值，不是合法路径；
// 判定必须走精确相等，不要用 glob 匹配，否则目录名里含 * 会被误判。
// 把它改成空数组语义会与「未授权任何工作区」混淆。
export const ALL_BOT_WORKSPACES = "*";
// [权衡] 绑定码 30s 有效：足够完成一次复制粘贴，又短到能限制暴力枚举窗口。
// 调大等于扩大爆破面；调小会让跨设备绑定频繁失败。
// TTL 只在这里定义，不要在消费端再写一份数值。
export const BOT_BIND_CODE_TTL_MS = 30_000;

// [契约] workspacePath 用于真实文件操作，workspaceIdentity 用于去重与绑定，
// 两者不可互相替代；远程工作区只有 identity 匹配可信。
// projectId 为空 roots 的虚拟项目在提交时才分配 cwd，提前填充会把草稿
// 锁死在当前目录。
export interface BotWorkspaceRef {
  id: string;
  label: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 新版选择虚拟项目；旧协议字段名保留。空 roots 在提交时才分配 cwd。 */
  projectId?: string;
  hostId?: string;
  rootPaths?: string[];
}

// [契约] 每个字段都对应一条可被 Bot 执行的命令能力，缺省不出现即表示未授权；
// 新命令必须同时在此、botAllowedCommandsSchema、DEFAULT_BOT_COMMANDS 三处登记。
// 只加 interface 字段而漏改 schema，会让该开关在持久化后被 strict 校验拒绝。
export interface BotAllowedCommands {
  status: boolean;
  new: boolean;
  workspace: boolean;
  model: boolean;
  mode?: boolean;
  thoughtLevel: boolean;
  sandboxMode?: boolean;
  approvalPolicy?: boolean;
  reply: boolean;
}

export type BotCommandPolicy = BotAllowedCommands;

// [契约] 保存的是 Bot 会话的当前选择（模型/模式/沙箱/审批），不是任务级覆盖；
// 任务启动时应复制一份，避免运行期被 Bot 命令改写。
// 字段均为可选：undefined 表示沿用宿主默认，而不是「显式无值」。
export interface BotCurrentOptions {
  modelSelection?: ModelSelection;
  mode?: string;
  sandboxMode?: string;
  approvalPolicy?: string;
}

export type BotReplyMode = BotReplyGranularity;

// [契约] 用户可编辑配置与运行时状态的分界线：这里只放可从配置文件重建的内容，
// 任何运行期游标（offset、任务 id）都必须放在 BotState。
// credentialRef/webhookSecretRef 存引用而非明文，写明文会进入备份与日志。
export interface BotConfig {
  id: string;
  name: string;
  provider: BotProvider;
  enabled: boolean;
  credentialRef?: string;
  webhookSecretRef?: string;
  webhookUrl?: string;
  webhookAuthHeaderName?: string;
  feishuAppId?: string;
  providerUserId?: string;
  displayName?: string;
  allowedWorkspaces: string[];
  allowedCommands: BotAllowedCommands;
  currentOptions: BotCurrentOptions;
  replyMode: BotReplyMode;
}

// [契约] 待处理权限选项按 requestId 关联任务内的权限请求；handledAt 一旦写入
// 即表示已处理，重放的回调必须据此丢弃。
// response 存的是完整回包而不是布尔值，因为不同 provider 的批准语义不同。
export interface BotPendingPermissionOption {
  requestId: string;
  optionId: string;
  command: "approve" | "deny";
  label: string;
  response: ZCodePermissionResponse;
  handledAt?: number;
}

export interface BotPendingElicitation {
  taskId: string;
  requestId: string;
  runId: string;
  origin?: ZCodeInteractionRequestOrigin;
  actorKey?: string;
  currentQuestionIndex: number;
  questions: ZCodeElicitationQuestion[];
  answers: Record<string, string[]>;
  renderContext?: {
    kind: "plan_approval";
    plan: string;
  };
  expandedCustomAnswerQuestionIndexes?: number[];
  handledAt?: number;
}

export interface BotStructuredElicitationResponse {
  requestId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface BotOutboundElicitationRequest {
  requestId: string;
  taskId: string;
  runId: string;
  currentQuestionIndex: number;
  questions: ZCodeElicitationQuestion[];
  answers?: Record<string, string[]>;
  status?: "pending" | "completed" | "cancelled";
  expandedCustomAnswerQuestionIndexes?: number[];
  schema?: unknown;
}

export interface BotDraftOptions {
  provider: ZCodeProvider;
  modelSelection?: ModelSelection;
  mode?: string;
}

// [契约] 文件级版本号固定为 3，与 botsConfigFileSchema 的 z.literal(3) 成对存在；
// 升级迁移必须先写新 schema 再改字面量，否则旧文件在启动时整体失败。
// bots 是数组：配置顺序即 UI 展示顺序，去重由 id 负责而不是下标。
export interface BotsConfigFile {
  version: 3;
  bots: BotConfig[];
}

// [契约] 状态文件按 botId 索引，单聊/群聊共用一个 BotState，群维度信息收敛在 group。
// [失败路径] activeTaskId 为 null 表示草稿态；把它改成空字符串会让「无活动任务」
// 与「任务 id 缺失」两种状态无法区分。
// updatedAt 是合并冲突的唯一依据，写入时必须刷新，不能沿用读到的旧值。
export interface BotState {
  botId: string;
  group?: BotGroupSession;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceId?: string;
  /** hostId 缺席表示旧状态待交接；明确 NULL 项目不会再次按目录归入。 */
  projectId?: string | null;
  hostId?: string;
  additionalDirectories?: string[];
  mode: BotContextMode;
  activeTaskId: string | null;
  draftOptions?: BotDraftOptions;
  pendingPermissionOptions?: BotPendingPermissionOption[];
  pendingElicitation?: BotPendingElicitation;
  telegramOffset?: number;
  weixinGetUpdatesBuf?: string;
  weixinActivatedAt?: number;
  /** 单聊绑定代际，阻止换绑后迟到事件恢复旧关联。 */
  privateBindingId?: string;
  /** iLink 登录返回机器人身份，单聊接收人来自已授权入站消息。 */
  privateRecipientId?: string;
  updatedAt: number;
}

export type BotContextState = BotState;

// [契约] 投递记录是幂等凭据：同 id 重复投递只读原回执，不再真正发送。
// status 包含 unknown/invalidated，用于表达「可能已发送但无法确认」，
// 不要把它简化为成功/失败二元，否则重试会产生重复消息。
// channelReplyRequestHash 见文件头 INV-08，删掉即破坏重试的收件人稳定性。
export const botGroupDeliverySchema = z
  .object({
    /** 名字解析前的请求指纹；重复调用只读原回执，不因目录变化改发给其他人。 */
    channelReplyRequestHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    appId: z.string().optional(),
    trace: zcodeProtocolTraceSchema.optional(),
    authorizationId: z.string().optional(),
    id: z.string().min(1),
    taskId: z.string().min(1),
    sourceCommandId: z.string().min(1).optional(),
    text: z.string(),
    replyToMessageId: z.string().optional(),
    mentionedUserIds: z.array(z.string().min(1)).max(200).optional(),
    contentParts: channelContentPartsSchema.optional(),
    providerMessageId: z.string().optional(),
    threadId: z.string().min(1).optional(),
    rootMessageId: z.string().optional(),
    status: z.enum(["pending", "sent", "failed", "unknown", "invalidated"]),
    lastError: z.string().optional(),
    updatedAt: z.number(),
  })
  .strict();
export type BotGroupDelivery = z.infer<typeof botGroupDeliverySchema>;

// [契约] 群卡片定位三元组：chatId + authorizationId 必填，threadId 区分话题卡片，
// taskId 允许 null 表示卡片尚未绑定任务。
// 卡片更新必须依赖这些字段重新定位，不能沿用旧 messageId。
export const botGroupCardSchema = z
  .object({
    chatId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    conversationThreadId: z.string().min(1).nullable().optional(),
    taskId: z.string().nullable(),
    authorizationId: z.string().min(1),
  })
  .strict();
export type BotGroupCard = z.infer<typeof botGroupCardSchema>;

// [契约] 话题历史消息的最小可渲染形状；senderType 区分 user/app，
// app 消息不得参与控制命令解析。
// controlCard/deleted 是展示开关，不影响消息是否进入上下文。
export const botTopicMessageSchema = z
  .object({
    id: z.string().min(1),
    chatId: z.string().min(1),
    threadId: z.string().min(1),
    senderId: z.string(),
    senderName: z.string().optional(),
    parentId: z.string().optional(),
    attachments: z.array(z.object({ name: z.string(), kind: z.string() }).strict()).optional(),
    senderType: z.enum(["user", "app"]),
    text: z.string(),
    createdAt: z.number(),
    kind: z.string(),
    controlCard: z.boolean().optional(),
    deleted: z.boolean().optional(),
  })
  .strict();
export type BotTopicMessage = z.infer<typeof botTopicMessageSchema>;

export interface BotTopicHistoryRequest {
  chatId: string;
  threadId: string;
  rootMessageId: string;
  messageId: string;
  checkpoint?: string;
}

// [契约] max(201) 与 botTopicHistorySourceSchema 的 messageCount 上限一致，
// 两处必须同步修改，否则 Host 组包通过、CLI 侧解析失败。
// checkpoint 必须等于触发消息 id，由 superRefine 校验，不可在此放松。
export const botTopicContextSchema = z
  .object({
    messages: z.array(botTopicMessageSchema).max(201),
    checkpoint: z.string().min(1),
    hasGap: z.boolean(),
  })
  .strict();
export type BotTopicHistoryBatch = z.infer<typeof botTopicContextSchema>;

// [契约] 机器人身份以 openId 为准、name 仅作展示；只能用 openId 做相等判断，
// 名字随时可能被改。
// 该结构只用于展示与去重，不授予任何执行权限。
export const botIdentitySchema = z
  .object({ name: z.string().min(1), openId: z.string().min(1).optional() })
  .strict();
export const botBackgroundHistorySchema = z
  .object({ revision: z.string().min(1), checkpoint: z.string().min(1).optional() })
  .strict();

// [契约] consecutive 上限 5 是防自激阈值：Bot 连续回复到第 5 次就必须停下等待
// 人工输入，避免两个 Bot 互相触发形成死循环。
// messageIds 记录已处理消息，用于去重；裁掉它会让重放的入站重复触发回复。
export const botAutoReplyGuardSchema = z
  .object({
    consecutive: z.number().int().min(0).max(5),
    messageIds: z.array(z.string().min(1)),
  })
  .strict();

// [契约] 群/话题会话的唯一状态容器；taskIds 与 taskWorkspaces 必须同时维护，
// 只写其一会让任务在工作区切换后找不到归属。
// [失败路径] topicActive=false 表示已 leave，但任务保留；据此停止普通消息触发，
// 不要删除 taskIds，否则用户回来后无法继续原任务。
// deliveries 以投递 id 为键，是幂等与重试的落点，不能改成数组追加。
export interface BotGroupSession {
  preparation?: BotTopicPreparation[];
  chatId: string;
  chatMode?: "group" | "topic";
  threadId?: string;
  rootMessageId?: string;
  topicTitle?: string;
  topicUrl?: string;
  /** 仅群默认记录拥有此配置；话题按群授权检查读取。 */
  historyEnabled?: boolean;
  /** 仅成功接收首次输入后接入；leave 后保留任务但停止普通消息触发。 */
  topicActive?: boolean;
  topicAliases?: Record<string, { taskId: string; rootMessageId: string }>;
  name: string;
  ownerId: string;
  enabled: boolean;
  taskIds: string[];
  taskWorkspaces?: Record<string, { workspacePath: string; workspaceIdentity?: string }>;
  currentOptions: BotCurrentOptions;
  initiatorId?: string;
  authorizationId?: string;
  deliveries?: Record<string, BotGroupDelivery>;
  autoReplyGuard?: z.infer<typeof botAutoReplyGuardSchema>;
  backgroundHistory?: z.infer<typeof botBackgroundHistorySchema>;
  inputs?: Record<
    string,
    {
      taskId: string;
      source: BotGroupInputSource;
      admission?: "pending" | "accepted" | "rejected";
      progress?: BotGroupInputProgress;
    }
  >;
}

// [契约] 入站输入的七态机，discarded 与 cancelled 语义不同：前者是入队前丢弃，
// 后者是任务已启动后被取消，UI 提示与清理动作都不同。
// 新增状态必须同步 BotGroupInputProgress 与前端卡片映射，否则卡片停在旧态。
export const botGroupInputStatusSchema = z.enum([
  "waiting",
  "working",
  "done",
  "failed",
  "stopped",
  "cancelled",
  "discarded",
]);
export type BotGroupInputStatus = z.infer<typeof botGroupInputStatusSchema>;
export const botTopicPreparationSchema = z
  .object({
    contentParts: channelContentPartsSchema.optional(),
    messageId: z.string().min(1),
    senderName: z.string(),
    text: z.string(),
    status: z.enum(["preparing", "waitingStop", "failed"]),
    error: z.string().optional(),
  })
  .strict();
export type BotTopicPreparation = z.infer<typeof botTopicPreparationSchema>;
// [契约] cardStatus 与 status 可以不同：status 是任务真实态，cardStatus 是卡片
// 已渲染态，两者分离才能表达「卡片更新失败但任务正常」。
// interruptionReason 目前只允许 newMessage，是「被新消息打断」的唯一标记。
export const botGroupInputProgressSchema = z
  .object({
    status: botGroupInputStatusSchema,
    interruptionReason: z.literal("newMessage").optional(),
    cardMessageId: z.string().min(1).optional(),
    cardStatus: botGroupInputStatusSchema.optional(),
  })
  .strict();
export type BotGroupInputProgress = z.infer<typeof botGroupInputProgressSchema>;

/** CLI 只接收轻量材料索引；原文留在 Host 归档及文本附件。 */
// [契约] 只传材料索引，不传原文：原文留在 Host 归档与文本附件，CLI 侧按需取。
// resourceMessages 的 count 上限 1000 是单消息附件数边界，放宽会让 IPC 消息体
// 无限增长。
// hasGap 表示历史中间有缺失，必须在上下文里显式告知模型，不能静默补全。
export const botTopicHistorySourceSchema = z
  .object({
    checkpoint: z.string().min(1).max(256),
    hasGap: z.boolean(),
    messageCount: z.number().int().min(0).max(201),
    resourceMessages: z
      .array(
        z
          .object({
            messageId: z.string().min(1).max(256),
            count: z.number().int().min(1).max(1000),
          })
          .strict(),
      )
      .max(201),
  })
  .strict();

// [契约] 单条入站消息的归一形状；attachmentIndexes 指向同批次附件数组，
// 不要在这里内联附件内容，否则同一附件会被复制多份。
// mentionedBot 来自 Provider 校验，仅用于回复提醒。
export const botTopicInputMessageSchema = z
  .object({
    contentParts: channelContentPartsSchema.optional(),
    messageId: z.string().min(1),
    senderId: z.string().min(1),
    senderName: z.string(),
    mentionedBot: z.boolean().optional(),
    text: z.string(),
    conversationQuotes: conversationQuotesSchema.optional(),
    attachmentIndexes: z.array(z.number().int().nonnegative()),
  })
  .strict();

/** 可信 Host 注入的输入来源；身份展示不能反向授予执行权限。 */
// [契约] 这是可信 Host 注入的输入来源，是本文件唯一带跨字段校验的 schema：
// messages 最后一条必须等于 messageId、checkpoint 必须一致、chatId/threadId 必须同源。
// provider 只允许 feishu|lark，其他渠道的群输入不走这条链路。
export const botGroupInputSourceSchema = z
  .object({
    botIdentity: botIdentitySchema.optional(),
    appId: z.string().min(1).optional(),
    contentParts: channelContentPartsSchema.optional(),
    authorizationId: z.string().min(1).optional(),
    botId: z.string().min(1),
    provider: z.enum(["feishu", "lark"]),
    chatId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    rootMessageId: z.string().optional(),
    senderId: z.string().min(1),
    senderName: z.string(),
    mentionedBot: z.boolean().optional(),
    messageId: z.string().min(1),
    messages: z.array(botTopicInputMessageSchema).min(1).max(200).optional(),
    topicContext: botTopicContextSchema.optional(),
    topicHistory: botTopicHistorySourceSchema.optional(),
  })
  .strict()
  // [事务] 三条 scope 校验是整批输入的原子性保证：任何一条不满足即整包拒绝，
  // 不做部分接受，否则上下文会混入别的会话内容。
  // 校验只依赖同包字段，不查库，因此可安全地在前置解析阶段执行。
  // 新增批次字段时必须补对应 scope 校验，见下面三个 addIssue。
  .superRefine((source, ctx) => {
    if (
      source.messages &&
      (!source.threadId ||
        source.messages.at(-1)?.messageId !== source.messageId ||
        new Set(source.messages.map((message) => message.messageId)).size !==
          source.messages.length)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        // [失败路径] 批次必须连续且末条等于触发消息，且 messageId 不得重复；
        // 重复项通常意味着 Host 重放，直接接受会让同一句话被回答两次。
        // 错误挂在 messages 路径上，前端据此定位到具体字段。
        message: "Topic batch boundary mismatch",
      });
    }

    if (
      source.topicHistory &&
      (!source.threadId || source.topicHistory.checkpoint !== source.messageId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["topicHistory"],
        // [失败路径] checkpoint 不等于 messageId 说明历史快照与本次触发不是同一线程，
        // 接受它会把上一轮话题的归档拼进当前上下文。
        // threadId 缺失时同样拒绝：没有线程归属就无法校验 scope。
        message: "Topic history scope mismatch",
      });
    }
    if (
      source.topicContext &&
      (!source.threadId ||
        source.topicContext.checkpoint !== source.messageId ||
        source.topicContext.messages.some(
          (m) => m.chatId !== source.chatId || m.threadId !== source.threadId,
        ))
    )
      ctx.addIssue({
        code: "custom",
        path: ["topicContext"],
        // [失败路径] 逐条校验 context 消息的 chatId/threadId，防止 Host 侧缓存串群；
        // 只校验 checkpoint 不够，历史消息本身也可能来自别的会话。
        // 该分支没有花括号，else 语句或后续新增逻辑前必须补齐，避免悬空。
        message: "Topic context scope mismatch",
      });
  });
export type BotGroupInputSource = z.infer<typeof botGroupInputSourceSchema>;

// [契约] 状态文件按 botId 建索引（record）而非数组，写入时可整键替换，
// 避免并发写同一 Bot 时数组下标漂移。
// version 同样固定 3，与 botsStateFileSchema 的 literal 成对。
export interface BotsStateFile {
  version: 3;
  bots: Record<string, BotState>;
}

// [契约] 只读的运行期快照，供 UI 展示；不参与持久化，重启后由进程重建。
// deliveryError 与 status 独立：长连接正常但投递失败是常见组合，
// 用 status=error 表达会误导用户去重连。
export interface BotRuntimeInfo {
  /** 最近一次消息投递错误；独立于长连接状态，成功投递后清除。 */
  deliveryError?: string;
  /** 当前进程保留的失败单聊回复；显式重试可能重复此前已收到的内容。 */
  deliveryRetryId?: string;
  botId: string;
  provider: BotProvider;
  status: "disabled" | "idle" | "polling" | "connected" | "error";
  messageId?: string;
  message?: string;
  lastUpdateAt?: number;
  offset?: number;
}

// [契约] actor 的全部字段来自 Provider 校验后的可信输入，是路由与审计的唯一依据。
// providerContextToken 是一次性回复凭据，禁止持久化后复用。
// conversationThreadId 允许 null：null 表示原群默认任务，undefined 表示未关联。
export interface BotActor {
  /** 本次可信输入是否明确提及机器人；用于话题回复提醒。 */
  mentionedBot?: boolean;
  provider: BotProvider;
  botId: string;
  providerUserId: string;
  displayName?: string;
  chatType: "private" | "group";
  chatId?: string;
  threadId?: string;
  /** 仅服务根据已保存的结果关联设置；null 表示原群默认任务。 */
  conversationThreadId?: string | null;
  rootMessageId?: string;
  topicTitle?: string;
  topicUrl?: string;
  providerMessageId?: string;
  providerContextToken?: string;
}

// [契约] 四种附件类别决定下游解析器与大小上限；新增类别必须同时更新解析分发，
// 否则会落到 file 分支被当成普通下载。
// 不要用扩展名推断类别，Provider 给出的是权威分类。
export type BotInboundAttachmentKind = "image" | "audio" | "video" | "file";

export interface BotInboundAttachment {
  id: string;
  kind: BotInboundAttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  providerFileId?: string;
  downloadUrl?: string;
  dataBase64?: string;
  localPath?: string;
  providerMetadata?: Record<string, string>;
}

// [契约] 命令联合类型是解析层与执行层的唯一契约；新增命令必须同时补
// allowedCommands 开关、SelectionPrompt.action 与执行分发。
// unknown 分支必须保留：未识别命令要能安全降级为提示，而不是抛错中断轮询。
// message 是普通输入而非命令，权限判定上与命令完全不同。
export type BotCommand =
  | { type: "group.history"; enabled?: boolean }
  | { type: "queue.cancel"; commandId: string }
  | { type: "group.enable" }
  | { type: "group.disable" }
  | { type: "bind"; code: string }
  | { type: "help" }
  | { type: "status" }
  | { type: "new" }
  | { type: "reconnect" }
  | { type: "workspace.list" }
  | { type: "workspace.set"; value: string }
  | { type: "model.list" }
  | { type: "model.provider.set"; value: string }
  | { type: "model.set"; value: string }
  | { type: "mode.list" }
  | { type: "mode.set"; value: string }
  | { type: "thoughtLevel.list" }
  | { type: "thoughtLevel.set"; value: string }
  | { type: "task.list" }
  | { type: "task.set"; value: string }
  | { type: "reply.list" }
  | { type: "reply.set"; value: string }
  | { type: "stop" }
  | { type: "topic.leave" }
  | { type: "permission.respond"; value: string }
  | { type: "elicitation.respond"; value: string }
  | { type: "elicitation.submit" }
  | { type: "approve"; requestId: string; optionId: string }
  | { type: "deny"; requestId: string }
  | { type: "unknown"; name: string; raw: string }
  | { type: "selection.cancel" }
  | { type: "message"; text: string };

// [契约] 选择菜单的服务端描述，action 必须与 BotCommand 中对应命令同名，
// 否则用户点击后无法映射回命令。
// token 是防伪造的一次性凭据，不能省略或复用；options 只携带展示所需字段。
export interface SelectionPrompt {
  id: string;
  token?: string;
  title: string;
  currentId?: string;
  cancelLabel?: string;
  showCancel?: boolean;
  action:
    | "queue.cancel"
    | "workspace.set"
    | "model.provider.set"
    | "model.set"
    | "mode.set"
    | "thoughtLevel.set"
    | "task.set"
    | "reply.set"
    | "permission.respond"
    | "elicitation.respond";
  options: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
}

// [契约] 入站消息的归一契约；text 与 contentParts 必须同时保留，
// 只留 text 会丢掉富文本结构，只留 parts 会让命令解析失去原文。
// commandText 仅用于命令识别，不得当作展示内容或上下文正文。
// [失败路径] 消息在进入业务层前必须完成鉴权与去重，本类型不代表已鉴权。
export interface BotInboundMessage {
  /** 仅供命令/纯唤醒识别；原文 text 和 contentParts 保持完整。 */
  commandText?: string;
  /** Provider 核验的当前机器人身份，不从正文推断。 */
  botOpenId?: string;
  /** Provider 校验的发送者类型；机器人正文不具有控制命令权限。 */
  senderType?: "user" | "app";
  contentParts?: ChannelContentPart[];
  /** 由 Provider 根据真实 mention 身份设置；不是正文解析结果。 */
  mentionedBot?: boolean;
  /** 原生根消息经 Provider 核验确为当前机器人发送。 */
  topicRootIsCurrentBot?: boolean;
  /** 可信 Provider 校验后的明确引用，不参与控制命令解析。 */
  referencedMessage?: import("./conversationSelection.js").ConversationSelectionText & {
    messageId: string;
  };
  groupCard?: BotGroupCard;
  groupCardAction?: boolean;
  botId: string;
  actor: BotActor;
  text: string;
  attachments?: BotInboundAttachment[];
  elicitationResponse?: BotStructuredElicitationResponse;
  receivedAt?: number;
}

// [契约] 出站消息必须携带 botId/provider/providerUserId 三元组，接收端据此选择
// 凭据与发送通道，缺一不可。
// callbackToastOnly 与 administratorAttention 是权限语义：无权限/过期的回调
// 只能提示操作者，不能覆盖群共享卡片。
// groupTaskId 存在时发送前必须重新校验群关联，控制命令回复不得携带。
export interface BotOutboundMessage {
  trace?: ZCodeProtocolTrace;
  contentParts?: ChannelContentPart[];
  groupCard?: BotGroupCard;
  threadId?: string;
  conversationThreadId?: string | null;
  rootMessageId?: string;
  botId: string;
  provider: BotProvider;
  providerUserId: string;
  text: string;
  locale?: Locale;
  selection?: SelectionPrompt;
  elicitation?: BotOutboundElicitationRequest;
  providerContextToken?: string;
  /** 无权限/过期回调只能提示操作者，不能覆盖群共享卡片。 */
  callbackToastOnly?: boolean;
  /** 管理员待办独立通知，不允许用拒绝提示覆盖共享卡片。 */
  administratorAttention?: boolean;
  replyToMessageId?: string;
  /** 可信输入决定的提醒对象；只作展示，不授予群操作权限。 */
  mentionedUserIds?: string[];
  deliveryId?: string;
  /** 任务回推需在实际发送前重新验证群当前关联。控制命令回复不携带。 */
  groupTaskId?: string;
  /** 可信任务事件中的输入命令，用于将投递状态定位到对应回复。 */
  groupSourceCommandId?: string;
}

// [契约] 任务列表摘要，status 额外包含 persisted-* 与 unknown：任务已不在内存但
// 状态文件仍有记录时必须能表达，不能一律报 unknown。
// workspacePath 与 workspaceIdentity 同时保留，供列表跳转与去重使用。
export interface BotTaskSummary {
  taskId: string;
  title: string;
  status: ZCodeTaskRuntimeStatus | "persisted-completed" | "persisted-error" | "unknown";
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  model?: string;
}

// [契约] 频道名是跨进程字符串协议，改名会让已连接的订阅方静默收不到事件；
// [契约] BOT_TASK_BROADCAST_CHANNEL 只许追加新频道：替换会让已连接的订阅方静默收不到事件。
// task 与 task-stream 分离：前者低频率状态，后者高频增量，订阅策略不同。
export const BOT_TASK_BROADCAST_CHANNEL = "bots:task";
export const BOT_TASK_STREAM_BROADCAST_CHANNEL = "bots:task-stream";

// [契约] 事件名是 UI 分支键，新增事件必须同步所有消费者，否则会被 unknown 分支吞掉。
// completed 与 error 是终态，出现后再收到 streaming 属于乱序，消费方需按
// taskId+updatedAt 丢弃过期事件。
export type BotTaskBroadcastEvent =
  | "created"
  | "prompt_sent"
  | "resumed"
  | "streaming"
  | "permission_request"
  | "permission_resolved"
  | "elicitation_request"
  | "elicitation_resolved"
  | "updated"
  | "completed"
  | "error";

// [契约] workspacePath 与 workspaceIdentity 必须同时带上：前者用于文件操作，
// 后者用于跨 Host 去重，只传一个会在远程工作区错配。
// prompt.permissionRequest 等字段按 event 类型出现，消费方不能假设恒存在。
export interface BotTaskBroadcastPayload {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  event: BotTaskBroadcastEvent;
  updatedAt: number;
  task?: ZCodeTaskMeta;
  provider?: ZCodeProvider;
  configOptions?: ZCodeConfigOption[];
  prompt?: {
    content: string;
    attachments?: ZCodePromptAttachment[];
    messageId: string;
    sentAt: number;
  };
  permissionRequest?: ZCodePermissionRequest;
  elicitationRequest?: ZCodeElicitationRequest;
  requestId?: string;
  error?: string;
}

// [契约] 流式载荷只带原始 ZCodeStreamEvent，不做二次整形，保证与协议层同构。
// updatedAt 用于乱序丢弃；缺少它时前端只能靠到达顺序猜测。
export interface BotTaskStreamBroadcastPayload {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  event: ZCodeStreamEvent;
  updatedAt: number;
}

// [契约] 服务状态是派生快照，四个计数字段必须同一次采样内计算，
// 分别统计会让 UI 出现 enabled > total 的矛盾展示。
// 不持久化，重启后由当前配置与运行期重新汇总。
export interface BotServiceStatus {
  botsCount: number;
  enabledBotsCount: number;
  contextsCount: number;
  botRuntime: BotRuntimeInfo[];
}

// [契约] 回调结果同时包含 reply 列表与可直接回写 HTTP 的 responseBody/status，
// adapter 层无需知道渠道细节。
// ok=false 时必须带 status，否则调用方无法区分签名失败与内部错误。
export interface BotProviderCallbackResult {
  ok: boolean;
  replies: BotOutboundMessage[];
  responseBody?: unknown;
  status?: number;
}

// [契约] 与 BotAllowedCommands 逐字段对应，strict 保证配置里不残留已删除命令；
// cli 字段只做旧配置兼容，新配置不再写入。
// mode/sandboxMode/approvalPolicy 可选是历史差异，不要统一改成必填，
// 否则旧配置文件全部解析失败。
export const botAllowedCommandsSchema = z
  .object({
    status: z.boolean(),
    new: z.boolean(),
    workspace: z.boolean(),
    model: z.boolean(),
    mode: z.boolean().optional(),
    thoughtLevel: z.boolean(),
    sandboxMode: z.boolean().optional(),
    approvalPolicy: z.boolean().optional(),
    // 兼容旧 bot-config.json；/cli 命令已移除，新配置不会再写入这个字段。
    cli: z.boolean().optional(),
    reply: z.boolean(),
  })
  .strict();

export const botCommandPolicySchema = botAllowedCommandsSchema;

// 修复原因：第三方 CLI provider 已移除，ZCodeProvider 只剩 glm，但旧 bot 配置与状态文件里可能仍存有
// 已移除 provider 的历史值。改成严格 literal 会让整份文件 parse 失败、Bot 全部不可用；
// 因此解析时继续接受这些历史值，并统一归一到当前唯一的 agent provider。
// [契约] 只归一不校验：历史 provider 值统一映射到当前唯一 agent provider。
// transform 的返回类型被显式标注，防止有人顺手把它改成 strict 校验。
// 新增历史别名时只需扩 enum，不要改 transform 输出，输出必须唯一。
const legacyBotAgentProviderSchema = z
  .enum(["codex", "claude", "opencode", "gemini", "glm"])
  .transform((): typeof ZCODE_AGENT_PROVIDER => ZCODE_AGENT_PROVIDER);

// [契约] 运行时选择与旧配置字段共用一个 schema：cli 字段在解析时归一，
// 写回时不会再产生该字段。
// modelSelection 等字段保持 optional，表示沿用宿主默认而非显式空值。
export const botCurrentOptionsSchema = z
  .object({
    modelSelection: modelSelectionSchema.optional(),
    mode: z.string().min(1).optional(),
    sandboxMode: z.string().min(1).optional(),
    approvalPolicy: z.string().min(1).optional(),
    // 兼容旧 bot-config.json；CLI provider 现在统一由 ZCode Protocol 侧配置决定。
    cli: legacyBotAgentProviderSchema.optional(),
  })
  .strict();

export const botDraftOptionsSchema = z
  .object({
    provider: legacyBotAgentProviderSchema,
    modelSelection: modelSelectionSchema.optional(),
    mode: z.string().min(1).optional(),
  })
  .strict();

const botElicitationOptionSchema = z
  .object({
    value: z.string(),
    label: z.string(),
    description: z.string().optional(),
  })
  .strict();

const botElicitationQuestionSchema = z
  .object({
    question: z.string(),
    header: z.string(),
    options: z.array(botElicitationOptionSchema),
    multiSelect: z.boolean().optional(),
  })
  .strict();

const botPendingElicitationSchema = z
  .object({
    taskId: z.string().min(1),
    requestId: z.string().min(1),
    runId: z.string().min(1),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    actorKey: z.string().min(1).optional(),
    currentQuestionIndex: z.number().int().min(0),
    questions: z.array(botElicitationQuestionSchema),
    answers: z.record(z.string(), z.array(z.string())),
    renderContext: z
      .object({
        kind: z.literal("plan_approval"),
        plan: z.string().min(1),
      })
      .strict()
      .optional(),
    expandedCustomAnswerQuestionIndexes: z.array(z.number().int().min(0)).optional(),
    handledAt: z.number().optional(),
  })
  .strict();

// [契约] 配置文件单个 Bot 的完整校验；allowedWorkspaces 允许空数组（未授权任何
// 工作区），但每个元素必须非空，避免空串被当成当前目录。
// webhookUrl 用 url() 校验，签名密钥只存 ref，不存明文。
export const botConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    provider: z.enum(botProviders),
    enabled: z.boolean(),
    credentialRef: z.string().min(1).optional(),
    webhookSecretRef: z.string().min(1).optional(),
    webhookUrl: z.string().url().optional(),
    webhookAuthHeaderName: z.string().min(1).optional(),
    feishuAppId: z.string().min(1).optional(),
    providerUserId: z.string().min(1).optional(),
    displayName: z.string().optional(),
    allowedWorkspaces: z.array(z.string().min(1)),
    allowedCommands: botAllowedCommandsSchema,
    currentOptions: botCurrentOptionsSchema,
    replyMode: z.enum([
      "assistant_changes",
      "assistant_toolcalls_changes",
      "summary_changes",
      "streaming_card",
    ]),
  })
  .strict();

// [契约] 配置文件的顶层形状固定 version=3 + bots 数组；不提供迁移函数，
// 旧版本由调用方在读取前转换。
// strict 保证未知顶层键报错而不是被忽略，便于发现手写配置的拼写错误。
export const botsConfigFileSchema = z
  .object({
    version: z.literal(3),
    bots: z.array(botConfigSchema),
  })
  .strict();

// [契约] 状态文件是运行期唯一持久化快照，字段必须与 BotState/BotGroupSession 对齐。
// [失败路径] 这里对 group/inputs 等嵌套结构重复声明而没有复用 interface，
// 新增字段时必须同时改两处，只改一处会导致重启后字段被 strict 丢弃。
// projectId 允许 null，是「明确不归属项目」的唯一表达。
export const botsStateFileSchema = z
  .object({
    version: z.literal(3),
    bots: z.record(
      z.string(),
      z.object({
        botId: z.string().min(1),
        group: z
          .object({
            chatId: z.string().trim().min(1),
            chatMode: z.enum(["group", "topic"]).optional(),
            threadId: z.string().trim().min(1).optional(),
            rootMessageId: z.string().min(1).optional(),
            topicTitle: z.string().optional(),
            topicUrl: z.string().url().optional(),
            historyEnabled: z.boolean().optional(),
            topicActive: z.boolean().optional(),
            preparation: z.array(botTopicPreparationSchema).optional(),
            topicAliases: z
              .record(
                z.string(),
                z.object({ taskId: z.string().min(1), rootMessageId: z.string().min(1) }).strict(),
              )
              .optional(),
            name: z.string(),
            ownerId: z.string().min(1),
            enabled: z.boolean(),
            taskIds: z.array(z.string().min(1)),
            taskWorkspaces: z
              .record(
                z.string(),
                z
                  .object({
                    workspacePath: z.string().min(1),
                    workspaceIdentity: z.string().optional(),
                  })
                  .strict(),
              )
              .optional(),
            currentOptions: botCurrentOptionsSchema,
            initiatorId: z.string().optional(),
            authorizationId: z.string().optional(),
            deliveries: z.record(z.string(), botGroupDeliverySchema).optional(),
            autoReplyGuard: botAutoReplyGuardSchema.optional(),
            backgroundHistory: botBackgroundHistorySchema.optional(),
            inputs: z
              .record(
                z.string(),
                z
                  .object({
                    taskId: z.string().min(1),
                    source: botGroupInputSourceSchema,
                    admission: z.enum(["pending", "accepted", "rejected"]).optional(),
                    progress: botGroupInputProgressSchema.optional(),
                  })
                  .strict(),
              )
              .optional(),
          })
          .strict()
          .optional(),
        workspacePath: z.string().min(1),
        workspaceIdentity: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
        projectId: z.string().min(1).nullable().optional(),
        hostId: z.string().min(1).optional(),
        additionalDirectories: z.array(z.string().min(1)).max(256).optional(),
        mode: z.enum(["draft", "task"]),
        activeTaskId: z.string().min(1).nullable(),
        draftOptions: botDraftOptionsSchema.optional(),
        pendingPermissionOptions: z
          .array(
            z.object({
              requestId: z.string().min(1),
              optionId: z.string().min(1),
              command: z.enum(["approve", "deny"]),
              label: z.string().min(1),
              response: zcodePermissionResponseSchema,
              handledAt: z.number().optional(),
            }),
          )
          .optional(),
        pendingElicitation: botPendingElicitationSchema.optional(),
        telegramOffset: z.number().optional(),
        weixinGetUpdatesBuf: z.string().optional(),
        weixinActivatedAt: z.number().optional(),
        privateBindingId: z.string().min(1).optional(),
        privateRecipientId: z.string().min(1).optional(),
        updatedAt: z.number(),
      }),
    ),
  })
  .strict();

// [契约] 新建 Bot 的权限基线：默认开放只读与切换类命令，默认关闭
// sandboxMode/approvalPolicy 等高风险项（缺省即不开放）。
// 改动默认值等于批量改变存量行为，必须当作产品变更评审。
export const DEFAULT_BOT_COMMANDS: BotAllowedCommands = {
  status: true,
  new: true,
  workspace: true,
  model: true,
  mode: true,
  thoughtLevel: true,
  reply: true,
};

// [契约] 默认回复粒度选 assistant_changes：只推最终变更，避免刷屏；
// streaming_card 是渠道专属能力，不能作为全局默认。
// 该常量被 normalizeBotReplyGranularity 兜底引用，改动影响所有未知配置的落点。
export const DEFAULT_BOT_REPLY_GRANULARITY: BotReplyGranularity = "assistant_changes";

// [契约] 能力裁剪的唯一入口：Feishu/Lark 只给 streaming_card，其余渠道给
// 非 streaming_card 的子集。
// [失败路径] 非飞书渠道返回 streaming_card 会发出无法更新的卡片，
// 用户永久看到「处理中」；这里的过滤顺序不能改成先全量再过滤。
export function getSupportedBotReplyGranularities(
  provider: BotProvider,
): readonly BotReplyGranularity[] {
  return isFeishuBotProvider(provider)
    ? (["streaming_card"] as const)
    : BOT_REPLY_GRANULARITIES.filter(
        // Bugfix: streaming card 依赖 Feishu/Lark Card JSON 2.0，其他 channel 无法渲染或更新该消息形态。
        (granularity) => granularity !== "streaming_card",
      );
}

// [契约] 永不抛错、总返回受支持值：未知或跨渠道的 replyMode 一律回落到
// supported[0]，保证 Bot 仍能启动。
// [失败路径] 若改成抛错，用户把 Bot 从飞书切到 telegram 后配置里的
// streaming_card 会让整个 Bot 无法加载。
export function normalizeBotReplyGranularity(
  provider: BotProvider,
  replyMode: BotReplyGranularity | undefined,
): BotReplyGranularity {
  const supported = getSupportedBotReplyGranularities(provider);
  const candidate = replyMode ?? DEFAULT_BOT_REPLY_GRANULARITY;
  return supported.includes(candidate) ? candidate : supported[0]!;
}

// [契约] UI 选择项由 ZCODE_AGENT_PROVIDER 派生，不再硬编码 provider 文案；
// 新增 provider 时只改 zcode-agent-policy，这里自动跟随。
// 保持数组形状而不是对象，是为了让 UI 直接按顺序渲染。
export const BOT_ZCODE_PROVIDER_OPTIONS: Array<{
  id: ZCodeProvider;
  label: string;
}> = [{ id: ZCODE_AGENT_PROVIDER, label: ZCODE_AGENT_PROVIDER_LABEL }];
