/**
 * ============================================================================
 * services/bots/botsService.ts —— Bot 接入与群协作服务（当前最大单文件）
 * ============================================================================
 *
 * 【定位】把外部 IM（飞书/企业微信/Telegram 等）的消息、命令、附件与
 * ZCode session/conversation 桥接起来，并维护群协作语义：
 *   - 私聊任务与群任务的路由；
 *   - 群 owner/管理员权限、@ 提及、话题（topic）续接；
 *   - 流式回复/卡片、队列卡、结果投递与节流；
 *   - bot 侧 elicitation/permission 的转发与回执。
 *
 * 【身份与授权】
 *   - BotGroupSource 是可信 metadata：只有它能把任务授权收紧为 session scope；
 *   - 普通正文不能改写该标记；
 *   - 群命令必须经过 owner/管理员判定，不能靠消息文本猜测身份；
 *   - 附件/话题资源必须先 authorize 再 read。
 *
 * 【状态归属】bot 只持有投递/话题/待处理交互等外部协作状态；
 *   conversation 正文事实仍在 CLI（command inbox + ProductProjection）。
 *   本文件不得建立第二份 accepted queue。
 *
 * 【维护提示】文件已远超 800 行。新增能力优先按"provider 适配 / 群编排 /
 *   投递与卡片"三类边界拆出，而不是继续把 provider 细节堆进本文件。
 * ============================================================================
 */
// ============================================================================
// 深度注释（DEEP-SPEC v1，L1 口径）——不变量速查表
// 编号沿用 BRIEF 的 INV-01…INV-12，全文件各段共享；本段只引用、不新增编号。
// 阅读方式：看到 [并发]/[事务]/[资源]/[失败路径]/[权衡] 标记，回到这里定位它守的 INV。
// 本段范围（1~1412）：文件头、imports 分组、阈值常量、纯函数（模型值编解码、选项解析、
//   权限选项渲染、outbound 组装）、createBotsService 的 repo/state/运行时工厂初始化。
// ----------------------------------------------------------------------------
// INV-01：群授权只来自 BotGroupSource/owner 等可信元数据；正文、@ 文本、回调 payload
//   都不能提升权限。守住位置：readContext 群分支的 ownerId 比对、writeContext 授权合并。
// INV-02：BotContextState 的权威副本在 BotsRepo 持久状态，内存只是投影；所有读改写
//   必须经 serializeStateWrite 串行。守住位置：stateWriteTail、writeContext、writeBotConfig。
// INV-03：入站投递幂等键必须在副作用之前占位，失败路径必须归还，否则同一消息被永久吞掉。
//   守住位置：recentInboundDeliveryAtByKey（占位表），键构造在后续段。
// INV-04：每个 accepted 输入最终必须有 terminal 结果；pending elicitation 与其选择态成对
//   创建/清理。本段相关：建话题上下文时不复制父级的待处理交互，避免制造悬挂交互。
// INV-05：远程 workspace 未连接时不得发起任务/输入/模型候选请求；重连投递有去重窗口。
//   守住位置：pendingRemoteReconnectsByKey、recentRemoteReconnect*AtByKey。
// INV-06：附件/话题资源必须先 authorize 再读取；大小、数量上限在读取前校验，超限走
//   用户可见错误而不是静默截断。守住位置：BOT_MAX_ATTACHMENT* 常量、附件准备流程。
// INV-07：群任务结果投递按 deliveryId 幂等；节流/队列卡只改变投递节奏，不得丢失终态。
//   守住位置：createGroupQueueCardSync 的三个回调、writeContext 的 deliveries 失效规则。
// INV-08：模型选择值必须可逆变回 {providerId, modelId}；无法识别时回退 ZCODE_AGENT_PROVIDER，
//   但不得静默改写用户显式选择。守住位置：formatBotModelSelectionValue/parseBotModelOptionValue。
// INV-09：流式卡片更新有最小间隔、请求超时与连续失败熔断；卡片链路失败必须降级到普通
//   消息。守住位置：FEISHU_STREAMING_CARD_* 常量、streamingCardRequestControllers。
// INV-10：bot 状态写入必须原子（repo 内临时文件 + rename）；内存与磁盘冲突时以持久状态
//   为准。守住位置：注入的 repo、所有 readState→改→writeState 分支、readContext 的回读。
// INV-11：elicitation/permission 选项 id 在「渲染→点击→回调」之间必须稳定；__form__: 前缀
//   与保留 id 不能与普通选项混淆。守住位置：BOT_ELICITATION_* 常量、权限选项排序。
// INV-12：disposeAll 之后不得再发网络请求、起定时器或写状态；重复 dispose 必须幂等。
//   守住位置：shutdownPromise、typingIntervals、streamingCardRequestControllers。
// ============================================================================
import { replyToBotChannel } from "#src/bots/channelReply.js";
import {
  BotAdminRequiredError,
  BotReplyError,
  createGroupAdminAttention,
} from "#src/bots/groupAdminAttention.js";
// 话题能力拆成三个独立模块：准备态（可观察的进度投影）、续接（把同一话题的连续输入
// 串成有序队列）、历史（读取范围与授权）。本文件只做编排，不在这里实现话题数据结构。
import { createTopicPreparationState } from "#src/bots/topicPreparationState.js";
import { createTopicContinuation } from "#src/bots/topicContinuation.js";
import { TopicHistoryPermissionError } from "#src/bots/topicHistory.js";
import {
  createTopicHistoryAttachment,
  botGroupCommandId,
} from "#src/bots/topicHistoryAttachment.js";
// 群投递拆成三块：节流（节奏）、结果投递（按 deliveryId 幂等）、队列卡（状态渲染）。
// 拆开的目的是让「不丢终态」这条可以单独测试，而不依赖整个 service 的上下文。
import { createGroupDeliveryThrottle } from "#src/bots/groupDeliveryThrottle.js";
import { createGroupResultDelivery } from "#src/bots/groupResultDelivery.js";
import { createGroupQueueCardSync } from "#src/bots/groupQueueCard.js";
// [资源] INV-06：topic resource 的 authorize 与 read 是两个入口，调用方必须先 authorize；
// 授权判定留在模块内，本文件拿不到绕过授权的旁路。
import { readAuthorizedTopicResource, authorizeTopicResource } from "#src/bots/topicResource.js";
// groupSessions 只提供群会话键、owner 命令判定、能否回答群问题这三个纯判断，不持有状态；
// 群的权威状态仍只在 BotsRepo（INV-02）。
import {
  getBotConversationKey,
  getBotStateKey,
  isGroupOwnerCommand,
  canAnswerGroupQuestion,
} from "./groupSessions.js";
/* eslint-disable max-lines -- Bots 服务仍复用原 RPC 文件名，先把鉴权、命令路由、ZCode Agent 桥接收口集中在同一服务内。 */
// node 内建排在业务 import 之后，是本文件既有的分组顺序（业务域在前、平台能力在后）；
// 新增 node 内建请跟随本组，不要插到顶部，否则每段的 import 区间都会互相冲突。
import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
// [权衡] 这一段全部是 type-only 导入：类型在编译期擦除，不会真的加载 @zcode/rpc 的
// 副作用入口；把其中一个改成值导入，就会把整棵依赖树拖进运行时。
import type { IDisposable } from "@zcode/rpc";
import { completeNewModelSelection } from "@zcode/provider";
import {
  ALL_BOT_WORKSPACES,
  parseRemoteWorkspaceIdentity,
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  generateTraceId,
  normalizeAgentProviderToZCodeAgent,
  ZCODE_AGENT_PROVIDER,
  BOT_TASK_BROADCAST_CHANNEL,
  BOT_TASK_STREAM_BROADCAST_CHANNEL,
  appendAssistantMessagePart,
  buildZCodeAssistantPresentation,
  decodeCustomModelValue,
  encodeCustomModelValue,
  getPermissionRequestPreview,
  getSupportedBotReplyGranularities,
  normalizeBotReplyGranularity,
  type ZCodeConfigOption,
  type ZCodeElicitationRequest,
  type ZCodeElicitationQuestion,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
  type ZCodePromptAttachment,
  type ZCodeTaskMode,
  type ZCodeAssistantMessagePart,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeProvider,
  type ZCodeStreamEvent,
  type TaskStreamMirrorableEvent,
  type ZCodeTaskMeta,
  type BotActor,
  type BotTaskBroadcastPayload,
  type BotTaskStreamBroadcastPayload,
  type BotConfig,
  type BotContextState,
  type BotDraftOptions,
  type BotCommand,
  type BotInboundAttachment,
  type BotInboundMessage,
  type BotOutboundMessage,
  type BotGroupDelivery,
  type BotGroupInputProgress,
  type BotGroupInputStatus,
  type BotPendingElicitation,
  type BotStructuredElicitationResponse,
  isFeishuBotProvider,
  type BotProvider,
  type BotProviderCallbackResult,
  type BotReplyGranularity,
  type BotRuntimeInfo,
  type BotWorkspaceRef,
  type ModelSelection,
  type BotsConfigFile,
  type Locale,
  type SelectionPrompt,
} from "@zcode/shared";
// 远端 runtime 只取契约类型：本文件不直接依赖实现，注入后可换成测试桩
// （见下方 BotRemoteWorkspaceService 的 Pick 定义）。
import type { BotRemoteRuntimeService } from "#src/bot-project-runtime/contract.js";
import {
  readProjectCatalog,
  projectSelectionId,
  type ProjectCatalogSnapshot,
} from "#src/project-catalog/index.js";
// 项目服务只按 Pick 使用读接口：prepareSession 是唯一有副作用的依赖，
// 其余 readProjects/readTree/readDirectory 都是纯读，便于在无项目环境下跑单测。
import type { IProjectService } from "#src/project/contract.js";
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";
// 同一个 @zcode/shared 的第二次导入：remote host identity 属于远端项目域，单独成组
// 是为了让「远端身份编解码」与「bot 协议类型」在阅读时不被混在一起。TS 会合并，无运行时开销。
import { buildRemoteHostWorkspaceIdentity, remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
// services 内部模块用相对路径（../session、../broadcast），包内跨层用 #src 别名；
// 两种写法都经 tsconfig paths 指向同一个包，统一改造会扩散到几十个 import，收益不抵风险。
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import { resolveProviderModeIdFromConfigOptions } from "#src/session/sessionModeOptions.js";
import { deriveSessionTitle as deriveTaskTitle } from "#src/session/sessionTitle.js";
import type { IBroadcastService } from "../broadcast/broadcast.js";
import type { ICredentialService } from "../credential/credential.js";
// getAppConfigDir 是 bot 状态/凭据落盘的根：所有持久化路径都必须由它派生。
// 自己拼 process.cwd() 会让桌面端与 CLI 端各自读到一份状态，互相看不见。
import { getAppConfigDir } from "../paths.js";
import type { ISettingService } from "../setting/setting.js";
// 只取 getView：模型候选与选择值都从 view 派生，本文件不写模型配置（INV-08 只管编解码）。
import type {
  IModelSelectionService,
  ModelSelectionView,
} from "../model-provider/providerFacadeServices.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  BotBindCodeResult,
  BotAutomationRunWatchParams,
  BotCreateBindCodeParams,
  BotListWorkspaceRefsParams,
  BotSaveBotParams,
  BotTestResult,
  BotUserConfigOptionsParams,
  IBotsService,
} from "./bots.js";
// 飞书应用注册是「扫码创建应用」的 begin/poll 两步流程，独立成模块以免把 OAuth 细节写进本文件。
import {
  beginFeishuAppRegistration,
  pollFeishuAppRegistration,
} from "./providers/feishuAppRegistration.js";
// config.js 提供绑定码 TTL、凭据 key 构造、命令策略、默认回复粒度等纯规则。
// 这些值属于持久化格式的一部分（已落盘状态依赖它们），所以集中而非散落成本地常量。
import {
  BOT_BIND_CODE_TTL_MS,
  buildBotCredentialKey,
  buildBotWebhookSecretKey,
  getDefaultBotReplyGranularity,
  normalizeBotCommandPolicy,
  normalizeBotCurrentOptions,
} from "./config.js";
// 菜单顺序是 help 文案映射与「数字编号选择」的共同权威：这里改顺序，帮助文本与编号解析同时变。
import { BOT_MENU_COMMAND_ORDER } from "./commandOrder.js";
// 命令解析只做语法切分；鉴权在 service 内按 actor 判定（INV-01），解析层不猜身份。
import { parseBotCommand } from "./commandParser.js";
// BotsRepo 负责原子落盘（临时文件 + rename）与状态加载（INV-10）；本文件只在
// serializeStateWrite 里调用它，不直接操作文件布局。
import { BotsRepo } from "./repo.js";
// provider 适配层契约：流式卡片/临时交互卡片句柄由 adapter 返回，本文件只持有句柄，
// 并在 dispose 时统一释放（INV-12）。
import type {
  BotProviderAdapter,
  BotStreamingReplyCardBlock,
  BotStreamingReplyCardHandle,
  BotTransientInteractionCardHandle,
  BotTypingTarget,
} from "./providers/types.js";
// 三个 provider 工厂各自封装协议差异（telegram 长轮询、feishu/lark 事件订阅、weixin 扫码）；
// 工厂内部不缓存 bot 配置，配置每次由本文件显式传入，避免两份配置。
import { createTelegramBotProvider } from "./providers/telegramProvider.js";
import { createWebhookBotProvider } from "./providers/webhookProvider.js";
import { createWeixinBotProvider } from "./providers/weixinProvider.js";
import {
  beginWeixinRegistration as beginWeixinQrRegistration,
  pollWeixinRegistration as pollWeixinQrRegistration,
} from "./providers/weixinRegistration.js";
import { createFeishuBotProvider, splitFeishuText } from "./providers/feishuProvider.js";
// formatBotMessage 统一 i18n 文案；BotMessageId 是文案键联合类型，保证不会拼错 key。
import { formatBotMessage, type BotMessageId } from "./messages.js";
// replyFormatter 把 assistant/tool 事件折叠成 IM 可读块；isBotToolCallReplyTerminal 决定
// 这条回复是否还能继续追加，属于投递语义的一部分（INV-07）。
import {
  extractBotAssistantResponseMessages,
  formatBotAssistantReplyBlocks,
  formatBotToolCallSummaryLine,
  formatBotPermissionRequestSummary,
  formatBotToolCallReply,
  isBotToolCallReplyTerminal,
  updateBotReplyToolCalls,
  type BotAssistantReplyBlock,
  type BotReplyToolCallState,
} from "./replyFormatter.js";
// botConfigHelpers 是纯函数集合：查找、鉴权、规范化配置，不读写 repo。
// 把「配置长什么样」与「配置怎么持久化」分开，避免本文件出现两种配置形状。
import {
  findBoundUser,
  findAuthorizedBot,
  findCallbackBot,
  findBot,
  isUserCommandAllowed,
  normalizeBotConfig,
  normalizeConfigBots,
} from "./botConfigHelpers.js";
// workspaceHelpers 负责 workspace ref 的键、标签、过滤与解析；getWorkspaceKey 是跨模块
// 比较口径，不能用字符串直接比路径代替（远端与本地可能同路径不同源）。
import {
  firstAllowedWorkspace,
  createWorkspaceRef,
  filterAllowedWorkspaces,
  getWorkspaceLabel,
  getWorkspaceKey,
  isWorkspaceAllowed,
  normalizeAllowedWorkspaces,
  normalizeConfiguredAllowedWorkspaces,
  resolveWorkspaceByValue,
} from "./workspaceHelpers.js";
// 模型 provider 名到原生 provider id 的映射只此一处，避免各处自行判断 ZCODE_AGENT_PROVIDER。
import { getNativeModelProviderId } from "./modelSelectionHelpers.js";
// statusFormatting 全是纯格式化：live status 文本、运行时长、工具进度。无副作用，
// 因此可以在卡片节流之外随时重算而不会触发网络。
import {
  formatStatusStreamToolProgress,
  formatStatusTaskLine,
  formatTaskRunningDuration,
  normalizeStatusProgressText,
  readLatestAssistantTurnChangeSummary,
  readLatestTaskProgress,
  readTaskWorkedDurationMs,
  taskStatus,
  truncateLiveStatusProgressText,
} from "./statusFormatting.js";
// 三个 channel runtime 负责 provider 的进程内生命周期（轮询循环、事件通道、runtime lock）；
// 本文件只提供 readConfig、游标读写与回调入口，不自己起循环——这样 dispose 才能一次收掉（INV-12）。
import { createTelegramChannelRuntime } from "./telegramChannelRuntime.js";
import { createBotTaskStreamHub } from "#src/bots/taskStreamHub.js";
import { createWeixinChannelRuntime } from "./weixinChannelRuntime.js";
import { createFeishuChannelRuntime } from "./feishuChannelRuntime.js";
// 内存诊断只登记计数回调（见下方 memoryDiagnostics），不注册任何持有消息内容的 provider。
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

// scope=bots：同 scope 下按等级过滤；与消息同量级的日志必须用 debug，否则生产日志随流量膨胀。
const botsLogger = createServiceLogger("bots");

// 模型选择值 → IM 选项值。返回 undefined 表示「没有选择」，调用方据此省略该选项而不是写空串。
// INV-08：原生 provider 直接用裸 modelId，其余 provider 交给 encodeCustomModelValue 编码成可逆串。
// 反过来若全部编码，用户在 CLI 侧看到的选中值会变成长串，且与已保存的旧值不兼容。
function formatBotModelSelectionValue(selection: ModelSelection | undefined): string | undefined {
  if (!selection) return undefined;
// 三分支不能合并：原生 provider 的 modelId 本身就是合法值，多包一层编码后不再等价（INV-08）。
  return selection.providerId === ZCODE_AGENT_PROVIDER
    ? selection.modelId
    : encodeCustomModelValue(selection.providerId, selection.modelId);
}

// 选项值 → 模型选择，三条降级路径：decode 解码、providerId/modelId 斜杠切分、整体当原生 modelId。
// 目的都是让「旧格式或手输的值」仍然可用；只有非空值才会回退 ZCODE_AGENT_PROVIDER（INV-08），
// 空串返回 undefined，避免把空选择伪造成默认模型。
function parseBotModelOptionValue(value: string): ModelSelection | undefined {
  const decoded = decodeCustomModelValue(value);
  if (decoded?.providerId && decoded.modelName) {
    return { providerId: decoded.providerId, modelId: decoded.modelName };
  }
// 斜杠两侧都非空才算 providerId/modelId；首字符或末字符是斜杠时不成立，防止切出空 provider。
  const separatorIndex = value.indexOf("/");
// [权衡] providerId 自身含斜杠时会被过早切分。这里选择「首个斜杠」而不是「最后一个」，
// 是为了与 encodeCustomModelValue 的输出格式对齐：编码端只会产生一个分隔符。
  if (separatorIndex > 0 && separatorIndex < value.length - 1) {
    return {
      providerId: value.slice(0, separatorIndex),
      modelId: value.slice(separatorIndex + 1),
    };
  }
// 兜底把整串当原生 modelId：历史卡片/用户手输常见「只写模型名」，这里必须接住，否则选择丢失。
  return value.trim() ? { providerId: ZCODE_AGENT_PROVIDER, modelId: value.trim() } : undefined;
}

// 回复粒度选项表。数组顺序 = 文本通道的编号（resolveReplyGranularityByValue 用 index+1 反查），
// 重排会静默改变用户已熟悉的编号；新增粒度应追加到末尾，并同步 label 与 aliases。
const BOT_REPLY_GRANULARITY_OPTIONS = [
  {
    id: "assistant_changes",
    label: { "zh-CN": "标准回复", "en-US": "Standard reply" },
    aliases: ["assistant", "assistant_changes", "normal", "default", "standard", "标准回复"],
  },
  {
    id: "assistant_toolcalls_changes",
    label: { "zh-CN": "完整回复", "en-US": "Full reply" },
    aliases: ["full", "tool", "toolcalls", "assistant_toolcalls_changes", "完整回复"],
  },
  {
    id: "summary_changes",
    label: { "zh-CN": "摘要回复", "en-US": "Summary reply" },
    aliases: ["summary", "summary_changes", "latest", "摘要回复"],
  },
  {
    id: "streaming_card",
    label: { "zh-CN": "流式卡片", "en-US": "Streaming card" },
    aliases: ["stream", "streaming", "streaming_card", "流式", "流式卡片"],
  },
// satisfies 双重约束：id 必须属于 BotReplyGranularity，label 必须双语齐全。
// 新增粒度漏写任一语言会直接编译失败，而不是运行时显示 undefined。
] as const satisfies ReadonlyArray<{
  id: BotReplyGranularity;
  label: Record<"zh-CN" | "en-US", string>;
  aliases: readonly string[];
}>;

// 独占凭据 provider：telegram/feishu/lark 一条凭据对应一个长轮询或事件连接，两个启用中的 bot
// 共用会互相抢更新（一方消费 offset 后另一方永久收不到）。weixin 不在此列：其凭据按收件人派生。
const BOT_EXCLUSIVE_CREDENTIAL_PROVIDERS = new Set<BotProvider>(["telegram", "feishu", "lark"]);
// INV-09 四个阈值，缺一都会退化成「卡死」或「打爆 API」：
// 1s 最小更新间隔——飞书卡片 patch 有频控，低于此值会连续 429；
// 15s 单次请求超时——挂住的 patch 不能拖住整条任务事件处理链；
// 1s 退避基数 + 3 次连续失败熔断——抖动期不无限重试，熔断后降级普通消息。
const FEISHU_STREAMING_CARD_MIN_UPDATE_INTERVAL_MS = 1_000;
const FEISHU_STREAMING_CARD_REQUEST_TIMEOUT_MS = 15_000;
const FEISHU_STREAMING_CARD_FAILURE_BACKOFF_BASE_MS = 1_000;
const FEISHU_STREAMING_CARD_FAILURE_CIRCUIT_THRESHOLD = 3;
// elicitation 进度广播 1s 超时：它只是「有人在看」的提示，丢了不影响正确性，绝不能阻塞提交。
const BOT_ELICITATION_PROGRESS_BROADCAST_TIMEOUT_MS = 1_000;
// provider 回调 ack 3s：第三方平台会因 ack 超时重投，ack 必须短于对端重试窗口；
// 重投本身由入站幂等键兜住（INV-03），所以这里宁可早 ack。
const BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS = 3_000;

// 流式卡片的时间线块：message 与 tools 交替出现，用于把工具调用摘要合并进正文。
// 用 union 而不是可选字段，让「有 text 就没有 toolIds」在类型层面成立，渲染端不必对空值二次判断。
type StreamingCardTimelineBlock =
  | {
      type: "message";
      text: string;
    }
  | {
      type: "tools";
      toolIds: string[];
    };

// 菜单命令 → help 文案键。键类型取自 BOT_MENU_COMMAND_ORDER 的元素联合，
// 菜单新增命令却忘记补 help 会编译失败，而不是运行时显示空帮助。
const helpMessageByCommand = {
  help: "helpHelp",
  bind: "helpBind",
  status: "helpStatus",
  new: "helpNew",
  workspace: "helpWorkspace",
  model: "helpModel",
  mode: "helpMode",
  thoughtLevel: "helpThoughtLevel",
  reply: "helpReply",
} as const satisfies Record<(typeof BOT_MENU_COMMAND_ORDER)[number], BotMessageId>;

// 保存前的配置校验：只在写入路径调用；加载路径不校验，这样手工改坏的配置仍能被读出来供修复。
// 三条规则都只针对「启用中的 bot」：停用的 bot 允许与其重复，便于切换或灰度时并存。
function validateBotConfig(config: BotsConfigFile, candidate: BotConfig): void {
// 空白 id 必须拒绝：getBotStateKey 依赖 botId，空 id 会让所有上下文塌陷到同一个键，互相覆盖。
  if (!candidate.id.trim()) {
    throw new Error("Bot id is required.");
  }
// 同一 provider + 同一 providerUserId 意味着两个 bot 抢同一条私聊入口，消息会随机落一个，必须拒绝。
  if (candidate.enabled && candidate.providerUserId?.trim()) {
    const duplicateBinding = config.bots.find(
      (bot) =>
        bot.id !== candidate.id &&
        bot.enabled &&
        bot.provider === candidate.provider &&
        bot.providerUserId === candidate.providerUserId,
    );
    if (duplicateBinding) {
// 错误信息不回显 providerUserId：它是用户标识，不写进可能被展示或上报的文本。
      throw new Error("An enabled bot with this provider user already exists.");
    }
  }
// 独占凭据冲突见 BOT_EXCLUSIVE_CREDENTIAL_PROVIDERS；只在 enabled 且填了 credentialRef 时检查。
  if (
    candidate.enabled &&
    candidate.credentialRef?.trim() &&
    BOT_EXCLUSIVE_CREDENTIAL_PROVIDERS.has(candidate.provider)
  ) {
    const duplicateCredential = config.bots.find(
      (bot) =>
        bot.id !== candidate.id &&
        bot.enabled &&
        bot.provider === candidate.provider &&
        bot.credentialRef === candidate.credentialRef,
    );
    if (duplicateCredential) {
// 典型误配是两个 bot 复制粘贴同一凭据；这里在写入前拦下，避免线上两个轮询互相吞消息。
      throw new Error("Enabled polling bots cannot share the same credential.");
    }
  }
}

// 依赖注入面：service 内部不 new 任何外部服务，全部通过接口注入，便于替换与测试。
interface BotsServiceDeps {
// credentialService：bot 凭据读写；adapter 每次发送时现取，因此轮换凭据无需重建 adapter。
  credentialService: ICredentialService;
// zcodeTaskService：任务/输入/事件订阅的唯一入口；本文件不碰 conversation 正文（见文件头状态归属）。
  zcodeTaskService: IZCodeTaskService;
// projectService 只取三个方法：prepareSession 是唯一写路径（建会话），其余是读。
  projectService: Pick<IProjectService, "readProjects" | "readTree" | "prepareSession">;
// remoteProjectService 可选：没有远端项目时，目录浏览回落到本地 projectService。
  remoteProjectService?: Pick<IRemoteProjectService, "readDirectory">;
// ownerHostId：本 host 的身份，用于区分本机 workspace 与远端 host workspace。
  ownerHostId?: string;
// broadcastService 可选：群状态/任务流广播；缺省时退化为无推送（CLI 内嵌），不影响投递正确性。
  broadcastService?: IBroadcastService;
// settingService 可选：读取语言等偏好；缺失时按默认 locale 渲染。
  settingService?: ISettingService;
// modelSelectionService 只取 getView：模型候选列表的唯一来源。
  modelSelectionService: Pick<IModelSelectionService, "getView">;
// remoteWorkspaceService 可选：远端 workspace 连接探测与重连（INV-05）。
  remoteWorkspaceService?: BotRemoteWorkspaceService;
// repo 可注入：测试与嵌入式场景可替换持久层；生产默认 new BotsRepo()（原子写由 repo 保证，INV-10）。
  repo?: BotsRepo;
  // 修复原因：desktop-attached 远端启动阶段不应抢跑 bot 轮询、runtime lock 和模型候选缓存；
  // 这些后台任务属于本地桌面 host，不属于 SSH/Docker 远端首屏连接路径。
// 默认 true；只有桌面端连接远端首屏时会传 false（原因见上方原有注释）。
  runStartupBackgroundTasks?: boolean;
}

// 重连结果类型直接取 ensureConnected 的返回值，避免本文件再定义一份形状而漂移。
type BotRemoteWorkspaceReconnectResult = Awaited<
  ReturnType<BotRemoteRuntimeService["ensureConnected"]>
>;
// Pick 强制 isConnected/ensureConnected 必须存在：没有连通性探测就无法守 INV-05；
// 其余能力（resolveWorkspace 等）可缺省，兼容不同宿主。
type BotRemoteWorkspaceService = Pick<BotRemoteRuntimeService, "isConnected" | "ensureConnected"> &
// Partial<Omit<...>> 让附加能力可选，但 isConnected/ensureConnected 被显式保留为必选。
  Partial<Omit<BotRemoteRuntimeService, "isConnected" | "ensureConnected">> & {
    resolveWorkspace?: (target: {
      workspacePath: string;
      workspaceIdentity: string;
    }) => Promise<{ workspacePath: string; workspaceIdentity: string } | null>;
  };

// generation 是话题准备代次：异步准备完成时代次已变，结果直接丢弃、不投递，
// 否则旧 prepared 内容会覆盖用户在准备期间输入的新内容。
interface PreparedTopicMessage {
  generation: number;
  message: BotInboundMessage;
  prepared: PreparedBotMessageContent;
}

// 准备好的内容 = 纯文本 + 已授权的附件引用。两者必须同批次产出，否则会出现
// 「文本已发、附件失败」的半成品投递，用户无法判断任务到底收到了什么。
interface PreparedBotMessageContent {
  content: string;
  zcodeAttachments: ZCodePromptAttachment[];
}

// 通过鉴权后的命令集合。新增命令必须同时出现在 parseBotCommand 与这个联合类型里，否则鉴权分支漏掉。
type BotAuthorizedCommand =
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
  | "approve";

// 绑定码仅存内存（TTL 见 BOT_BIND_CODE_TTL_MS）：进程重启即失效，这是安全属性——绑定码等同一次性口令。
interface BindCodeRecord {
// expiresAt 用绝对时间戳而非剩余毫秒：跨 await 后判定仍单调，不受调用延迟影响。
  botId: string;
  code: string;
  allowedWorkspaces: string[];
  expiresAt: number;
}

interface BotModelOption {
// 模型选项的展示形状与 provider 选项分开，便于文本通道只渲染一层。
  id: string;
  label: string;
  description?: string;
}

interface BotModelProviderOption {
  id: string;
  label: string;
  description?: string;
  models: BotModelOption[];
}

// 任务选择项携带 workspace：用户从列表里选中的其实是「某 workspace 下的某任务」。
interface BotTaskSelectionEntry {
  task: ZCodeTaskMeta;
  workspacePath: string;
  workspaceIdentity?: string;
}

// workspace 选择项只包一层，留出以后附加字段的余地而不改 map 的 value 类型。
interface BotWorkspaceSelectionEntry {
  workspace: BotWorkspaceRef;
}

// 以下四个是不可信 payload 的安全读取工具：只判断形状，不解释语义。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// [权衡] 数组也会通过 isRecord（typeof object 且非 null），这里不加 Array.isArray 排除：
// 飞书事件确实可能把字段给成数组，交给各 reader 自行处理比统一拒绝更实际。
function readNestedRecord(
  value: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const nested = value?.[key];
  return isRecord(nested) ? nested : null;
}

// 空串/纯空白视为缺失：payload 里常见空字符串，返回空串会让下游把它当成本地值使用。
function readNestedString(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const nested = value?.[key];
  return typeof nested === "string" && nested.trim().length > 0 ? nested : undefined;
}

// 回调摘要只用于日志：只输出键名与少量枚举字段，绝不拼接 message 正文或 action 参数，
// 避免把用户聊天内容、审批选项写进生产日志。
function summarizeCallbackPayload(payload: unknown): string {
  if (!isRecord(payload)) {
    return `type=${typeof payload}`;
  }
// header/event/context/action 四层是飞书回调的固定嵌套；payload 也可能直接是 event 体，故 event ?? payload。
  const header = readNestedRecord(payload, "header");
  const event = readNestedRecord(payload, "event") ?? payload;
  const message = readNestedRecord(event, "message");
  const context = readNestedRecord(payload, "context");
  const action = readNestedRecord(payload, "action");
// 最多 16 个键：payload 可能很大，截断保证日志行长度可控且不会被外部输入撑爆。
  const keys = Object.keys(payload).slice(0, 16).join(",");
  return [
// keys 为空时输出 none：否则日志里只剩 keys=，会被误读成字段被清空。
    `keys=${keys || "none"}`,
    `botId=${readNestedString(payload, "botId") ?? "none"}`,
    `eventType=${readNestedString(header, "event_type") ?? readNestedString(header, "type") ?? readNestedString(payload, "event_type") ?? "none"}`,
    `messageType=${readNestedString(message, "message_type") ?? "none"}`,
    `chatType=${readNestedString(message, "chat_type") ?? readNestedString(context, "chat_type") ?? readNestedString(payload, "chat_type") ?? "none"}`,
    `hasAction=${action ? "true" : "false"}`,
  ].join(" ");
}

// 绑定码 3 字节 = 6 位十六进制（32^6 约 10.7 亿），配合 10 分钟 TTL 且仅存内存，足以抵抗枚举；
// 加长会抬高用户手输成本，缩短则熵不足。
function createCode(): string {
// 大写十六进制：用户要在 IM 里手输，统一大写减少抄错。
  return randomBytes(3).toString("hex").toUpperCase();
}

// 归一化只做 trim + 小写：用于别名/编号匹配，不做全角半角转换（会改变中文标签的匹配语义）。
function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

// 回复粒度候选：先按 provider 支持集合过滤，再按 locale 取 label。
// 过滤放在这里而不是渲染端，保证「文本编号」与「卡片选项」看到同一组候选。
function getReplyGranularityOptions(locale: Locale | undefined, provider?: BotProvider) {
  const messageLocale = locale === "en-US" ? "en-US" : "zh-CN";
// supportedIds 为 null 表示不过滤（未知 provider 或无限制），与后端 capabilities 的缺省语义一致。
  const supportedIds = provider ? new Set(getSupportedBotReplyGranularities(provider)) : null;
  return BOT_REPLY_GRANULARITY_OPTIONS.filter(
    (option) => !supportedIds || supportedIds.has(option.id),
  ).map((option) => ({
    id: option.id,
    label: option.label[messageLocale],
  }));
}

// 文本通道的粒度输入同时接受序号与别名/双语标签：
// 序号按过滤后的候选顺序解释（与渲染顺序一致）；别名在全表里查再回填到候选集，
// 因此用户输入某个 provider 不支持的粒度别名会得到 null，而不会被越权启用。
function resolveReplyGranularityByValue(
  value: string,
  locale: Locale | undefined,
  provider?: BotProvider,
) {
  const trimmed = value.trim();
// 序号从 1 开始（0 留给取消），超出候选长度返回 null，由调用方提示重选而不是静默回退默认值。
  const index = Number.parseInt(trimmed, 10);
  const options = getReplyGranularityOptions(locale, provider);
  if (Number.isFinite(index) && index > 0) {
    return options[index - 1] ?? null;
  }
  const normalized = normalizeText(trimmed);
  const option = BOT_REPLY_GRANULARITY_OPTIONS.find(
    (item) =>
      (item.aliases as readonly string[]).includes(normalized) ||
      normalizeText(item.label["zh-CN"]) === normalized ||
      normalizeText(item.label["en-US"]) === normalized,
  );
  return option ? (options.find((item) => item.id === option.id) ?? null) : null;
}

// 通用选项解析：支持 1-based 序号与 id/label 文本匹配。
// 正则 ^[1-9]\d*$ 排除 0 与前导零：0 在别处被解释成「取消」，前导零只会是手滑。
function resolveOptionByValue<T extends { id: string; label: string }>(
  items: T[],
  value: string,
): T | null {
  const trimmed = value.trim();
  if (/^[1-9]\d*$/u.test(trimmed)) {
// 序号分支先于文本匹配：label 理论上也可能长成纯数字，序号必须优先解释。
    const index = Number.parseInt(trimmed, 10);
    return items[index - 1] ?? null;
  }
  const normalized = normalizeText(trimmed);
  return (
    items.find(
      (item) => normalizeText(item.id) === normalized || normalizeText(item.label) === normalized,
    ) ?? null
  );
}

// 判断用户输入是不是序号，用于区分选择分支与普通文本输入。
function isSelectionIndexValue(value: string): boolean {
  return /^[1-9]\d*$/u.test(value.trim());
}

// 组装出站消息。所有字段都来自 actor + 显式入参，不做任何反查，
// 因此同一 actor 调两次得到同一个目标，投递幂等键可以直接基于这些字段拼（INV-07）。
function createOutbound(
  actor: BotActor,
  text: string,
  selection?: SelectionPrompt,
  extras: Pick<
    BotOutboundMessage,
    "elicitation" | "locale" | "groupSourceCommandId" | "groupTaskId"
  > = {},
): BotOutboundMessage {
// 收件人取 chatId ?? providerUserId：群消息必须发到 chat，私聊时 chatId 缺失才回退到用户 id。
  return {
// 逐字段赋值而不是展开 actor：出站消息不应把 actor 的内部字段（mentionedBot 等）泄漏给 provider。
    botId: actor.botId,
    provider: actor.provider,
    providerUserId: actor.chatId ?? actor.providerUserId,
// 飞书群消息默认「回复原消息」：线程外需要显式 @ 提问者，线程内则不重复 @（避免自己 @ 自己）。
// mentionedBot=true 表示原消息已 @ 过 bot，此时仍要 @ 用户本人，否则对方收不到通知。
    ...(isFeishuBotProvider(actor.provider) && actor.chatType === "group" && actor.providerMessageId
      ? {
          replyToMessageId: actor.providerMessageId,
          mentionedUserIds:
            !actor.threadId || actor.mentionedBot === true ? [actor.providerUserId] : undefined,
        }
      : {}),
// threadId 与 rootMessageId 必须成对下发：只带 threadId 时飞书无法定位话题根，回复会回落成群消息。
    ...(actor.threadId ? { threadId: actor.threadId, rootMessageId: actor.rootMessageId } : {}),
// conversationThreadId 是「会话级话题」，与 threadId 不同，仅在显式传入时下发，不能用 ?? 兜底。
    ...(actor.conversationThreadId !== undefined
      ? { conversationThreadId: actor.conversationThreadId }
      : {}),
    text,
    ...(selection ? { selection } : {}),
    ...extras,
// contextToken 放在 extras 之后展开：它是协议层必填项，不允许被 extras 覆盖。
    ...(actor.providerContextToken ? { providerContextToken: actor.providerContextToken } : {}),
  };
}

// 群卡片定位参数。non-null 断言依赖调用点已确认处于群上下文（context.group 存在）；
// authorizationId 是群授权唯一标识，缺失时卡片回调无法验证来源，所以不做兜底。
function groupCardFor(
  actor: BotActor,
  context: BotContextState,
): import("@zcode/shared").BotGroupCard {
// actor.threadId 优先于 group.threadId：话题内的卡片要落在话题线程，而不是群主线程。
  const group = context.group!;
  const threadId = actor.threadId ?? group.threadId;
  return {
    chatId: group.chatId,
    threadId,
    taskId: context.activeTaskId,
    authorizationId: group.authorizationId!,
// 两者不同才带额外字段：相同时沿用群线程，避免每条卡片都背一个冗余的 conversationThreadId。
    ...(threadId !== group.threadId ? { conversationThreadId: group.threadId ?? null } : {}),
  };
}

// 自动化投递目标：只有 feishu/lark/weixin 支持——它们有稳定的主动推送通道。
// telegram 的会话 id 不能跨重启复用，webhook 没有默认收件人，因此返回 undefined 让上游放弃自动投递。
function resolveAutomationBotDeliveryTarget(
  actor: BotActor,
): ZCodeAutomationBotDeliveryTarget | undefined {
  if (actor.provider !== "feishu" && actor.provider !== "lark" && actor.provider !== "weixin") {
    return undefined;
  }
// chatId 优先：自动化投递必须打到群/会话；用用户 id 会在群里退化成私聊。
  const providerUserId = actor.chatId?.trim() || actor.providerUserId.trim();
  if (!providerUserId) return undefined;
  return {
    provider: actor.provider,
    botId: actor.botId,
    providerUserId,
    chatType: actor.chatType,
    ...(actor.threadId ? { threadId: actor.threadId, rootMessageId: actor.rootMessageId } : {}),
  };
}

// 纯文本通道的选项降级渲染：编号 + label + 可选描述，末尾附解析提示。
// 只输出编号、不展开完整命令与路径，是因为微信消息长度有限，长 workspace identity 会把消息刷爆。
function formatSelectionFallback(selection: SelectionPrompt, locale?: Locale): string {
  const lines = selection.options.map((option, index) => {
    const description = option.description ? ` ${option.description}` : "";
    return `${index + 1}. ${option.label}${description}`;
  });
  // Bugfix: 微信这类纯文本通道没有原生选项卡，之前把完整 slash command 和长路径展开，
  // workspace/remote identity 会把消息刷得很长。这里只展示编号，数字解析仍走 pending selection。
// showCancel === false 表示当前选择不可取消（例如必须先选模型），此时不渲染 0. 取消，
// 否则用户按 0 会走进一个无处可去的分支。
  if (selection.showCancel === false) {
    return `${selection.title}\n${lines.join("\n")}\n\n${formatBotMessage(locale, "selectionTextHintNoCancel")}`;
  }
  const cancelLabel = selection.cancelLabel ?? formatBotMessage(locale, "selectionCancelOption");
// 0 号固定为取消，与 isSelectionIndexValue 的 1-based 规则互补，解析端不需要额外分支。
  return `${selection.title}\n0. ${cancelLabel}\n${lines.join("\n")}\n\n${formatBotMessage(locale, "selectionTextHint")}`;
}

// 权限选项的展示分类：只用于排序与文案，不参与回调（选项 id 原样保留，INV-11）。
type BotPermissionOptionDisplayKind =
  | "allowOnce"
  | "allowAlways"
  | "rejectOnce"
  | "rejectAlways"
  | "custom";

// 展示优先级：允许一次 < 始终允许 < 拒绝一次 < 始终拒绝 < 自定义。
// 意图是「非破坏性在前、一次性在前」，让误触代价最小的选项落在列表顶部（即编号 1）。
const BOT_PERMISSION_OPTION_PRIORITY = {
  allowOnce: 0,
  allowAlways: 1,
  rejectOnce: 2,
  rejectAlways: 3,
  custom: 4,
} as const satisfies Record<BotPermissionOptionDisplayKind, number>;

// [权衡] 用 optionId/kind/name 拼串 + 正则推断语义，而不是要求上游给结构化 kind：
// CLI 侧权限选项形状不统一；代价是名称里出现 allow/deny 会被误判。
// 因此结果只影响排序与文案，真正授权仍由 option id 决定（INV-01/INV-11）。
function getBotPermissionOptionDisplayKind(
  option: ZCodePermissionOption,
): BotPermissionOptionDisplayKind {
// 三段一起匹配：optionId 常是 allow_once 这类蛇形，name 是本地化文案，单看一处都不够。
  const text = `${option.optionId} ${option.kind} ${option.name}`.toLowerCase();
  const isAlways =
    /\b(always|persistent|permanent|remember)\b/u.test(text) ||
    /始终|永久|记住|不再询问/u.test(text);
  const isAllow = /\b(allow|approve|accept|yes)\b/u.test(text) || /允许|同意|批准/u.test(text);
  const isReject = /\b(deny|reject|decline|no)\b/u.test(text) || /拒绝|不允许|否/u.test(text);
  if (isAllow) {
    return isAlways ? "allowAlways" : "allowOnce";
  }
  if (isReject) {
    return isAlways ? "rejectAlways" : "rejectOnce";
  }
  return "custom";
}

// 复制一份再排序：入参来自上游事件对象，原地排序会改到别人的数组。
// 现代 V8 的 sort 是稳定排序，同类选项保持上游顺序，回调 id 不会因排序而错位（INV-11）。
function sortBotPermissionOptions(
  options: readonly ZCodePermissionOption[],
): ZCodePermissionOption[] {
  return [...options].sort((left, right) => {
// 只比较优先级、不比较 id：同优先级由稳定排序保持上游顺序，选项不会跳位（INV-11）。
    const leftPriority = BOT_PERMISSION_OPTION_PRIORITY[getBotPermissionOptionDisplayKind(left)];
    const rightPriority = BOT_PERMISSION_OPTION_PRIORITY[getBotPermissionOptionDisplayKind(right)];
    return leftPriority - rightPriority;
  });
}

// 标签只覆盖「一次/始终 × 允许/拒绝」；custom 直接回落上游 name，绝不自造文案以免误导授权范围。
function formatBotPermissionOptionLabel(option: ZCodePermissionOption, locale?: Locale): string {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  if (locale === "en-US") {
    switch (displayKind) {
      case "allowOnce":
        return "Allow";
      case "allowAlways":
        return "Always Allow";
      case "rejectOnce":
        return "Deny";
      case "rejectAlways":
        return "Always Deny";
      case "custom":
        return option.name;
    }
  }
  switch (displayKind) {
    case "allowOnce":
      return "允许";
    case "allowAlways":
      return "始终允许";
    case "rejectOnce":
      return "拒绝";
    case "rejectAlways":
      return "始终拒绝";
    case "custom":
      return option.name;
  }
}

// 描述必须区分作用域（command/file/其它），否则「始终允许」会被用户读成全局永久授权。
// 作用域取自 getPermissionRequestPreview，本文件不自行解析请求体。
function formatBotPermissionOptionDescription(
  option: ZCodePermissionOption,
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
  locale?: Locale,
): string | undefined {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  if (displayKind === "custom") {
// custom 的描述直接用 option.kind：上游没给语义分类时，暴露原始类型比编造文案诚实。
    return option.kind;
  }
  const scope = getPermissionRequestPreview(request).scope;
  if (locale === "en-US") {
    if (displayKind === "allowOnce") {
      return "Allow this time only";
    }
    if (displayKind === "rejectOnce") {
      return "Reject this time";
    }
    if (displayKind === "allowAlways") {
      return scope === "command"
        ? "Do not ask again for the same command"
        : scope === "file"
          ? "Do not ask again for the same file operation"
          : "Do not ask again for the same permission request";
    }
    return scope === "command"
      ? "Always reject the same command"
      : scope === "file"
        ? "Always reject the same file operation"
        : "Always reject the same permission request";
  }
  if (displayKind === "allowOnce") {
    return "仅允许这一次";
  }
  if (displayKind === "rejectOnce") {
    return "这次先拒绝";
  }
  if (displayKind === "allowAlways") {
    return scope === "command"
      ? "后续相同命令不再询问"
      : scope === "file"
        ? "后续相同文件操作不再询问"
        : "后续相同权限请求不再询问";
  }
  return scope === "command"
    ? "后续相同命令也会直接拒绝"
    : scope === "file"
      ? "后续相同文件操作也会直接拒绝"
      : "后续相同权限请求也会直接拒绝";
}

// 拒绝判定同时被「默认选项」与「回执文案」使用，集中一处避免两处正则漂移。
function isBotPermissionRejectOption(option: ZCodePermissionOption): boolean {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  return displayKind === "rejectOnce" || displayKind === "rejectAlways";
}

// 文本通道去掉 provider 描述：模型 provider 描述很长，纯文本列表会被撑成多屏；
// 仅对 model.provider.set 生效，其它选择（workspace/task）的描述是必要信息，必须保留。
function stripModelProviderDescriptionsForTextSelection(
  selection: SelectionPrompt,
): SelectionPrompt {
  if (selection.action !== "model.provider.set") {
// 返回新对象而不是改原 selection：原对象可能已存进 pending 选择，就地改会让编号与已发文本错位。
    return selection;
  }
  return {
    ...selection,
    options: selection.options.map((option) => ({
      ...option,
      description: undefined,
    })),
  };
}

// 远端 workspace 加后缀标记：本地与远端可能同名，没有标记用户无法分辨，容易选错执行环境。
function formatWorkspaceOptionLabel(workspace: BotWorkspaceRef, locale?: Locale): string {
  if (!workspace.workspaceIdentity) {
    return workspace.label;
  }
  const remoteLabel = locale === "en-US" ? "[Remote]" : "[远端]";
  return `${workspace.label} ${remoteLabel}`;
}

// 统一延时工具：只用于退避/节流路径，不用于等待网络结果（那必须用事件或 Promise）。
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 默认 provider：bot 未显式选模型时落到 ZCode agent，与 CLI 侧默认保持一致。
const DEFAULT_BOT_ZCODE_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;
// Bot 模式硬锁 yolo：所有 bot task 一律免交互权限，且禁止通过 /mode 切换运行模式。
const BOT_FORCED_MODE = "yolo";
// typing 每 4s 续期：飞书「正在输入」约 5s 过期，留 1s 余量；再频繁会触发频控。
const BOT_TYPING_INTERVAL_MS = 4_000;
// 任务元信息重试 80/160/320ms 共三次：任务刚创建时 conversation 可能尚未落盘，
// 三次覆盖首包写入窗口，总等待不到 0.6s，不会明显拖慢首条回复。
const BOT_TASK_META_RETRY_DELAYS_MS = [80, 160, 320] as const;
// INV-06 附件硬上限：单条 4 个。超限在下载前判掉，走用户可见错误，不静默截断。
const BOT_MAX_ATTACHMENTS_PER_MESSAGE = 4;
// 单个 5MB：IM 侧常见上限与内存占用的折中——附件还要解码并 base64 进 prompt，过大直接拖慢任务启动。
const BOT_MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;
// 下载 30s 超时：卡住的 HTTP 连接必须能释放，否则一条坏附件会长期占住并发槽。
const BOT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
// 重连去重 3s：用户连点「重连」只触发一次 ensureConnected；只覆盖抖动，不覆盖业务级重复。
const REMOTE_RECONNECT_DEDUPE_TTL_MS = 3_000;
// 重连后投递去重 2min：重连会重放离线消息，窗口内相同投递只发一次（INV-05）。
const REMOTE_RECONNECT_DELIVERY_DEDUPE_TTL_MS = 2 * 60_000;
// 入站去重 2min 与投递窗口同量级：两者面对同一批重放消息，窗口不齐会出现一边放行一边拦截。
const BOT_INBOUND_DELIVERY_DEDUPE_TTL_MS = 2 * 60_000;
// 自动化投递告警 5min：同一 bot 反复失败只提示一次，避免告警刷屏。
const BOT_AUTOMATION_DELIVERY_WARNING_TTL_MS = 5 * 60_000;
// INV-11 保留 id：elicitation 的「自定义输入/提交/跳过」与表单值前缀。
// 这些 id 会原样下发进卡片再回传，必须与普通选项 id 不可能重复；__form__: 之后的原文即用户输入。
const BOT_ELICITATION_CUSTOM_OPTION_ID = "__custom__";
const BOT_ELICITATION_SUBMIT_OPTION_ID = "__submit__";
const BOT_ELICITATION_SKIP_OPTION_ID = "__skip__";
const BOT_ELICITATION_FORM_VALUE_PREFIX = "__form__:";

// 工厂入口：返回 IBotsService 之外额外暴露 disposeAll/disposeAllAndWait，
// 因为宿主（桌面/CLI）需要在退出时确定性地收掉轮询、定时器与订阅（INV-12）。
// 全部内部状态都是本函数的闭包变量，没有模块级可变状态，因此同进程可创建多个实例（测试用）。
export function createBotsService(
  deps: BotsServiceDeps,
): IBotsService & { disposeAll(): void; disposeAllAndWait(): Promise<void> } {
// 只有显式 false 才关闭启动期后台任务：远端首屏连接传 false，避免抢轮询、runtime lock 与模型候选缓存。
  const runStartupBackgroundTasks = deps.runStartupBackgroundTasks !== false;
// repo 默认 new BotsRepo()：原子写与加载口径都在 repo 内，本文件不碰文件布局（INV-10）。
  const repo = deps.repo ?? new BotsRepo();
// 绑定码表只在内存：见 BindCodeRecord 说明；不落盘意味着重启即失效，这是安全属性。
  const bindCodes = new Map<string, BindCodeRecord>();
// 自动化投递告警节流表：记录上次告警时间（TTL 见 BOT_AUTOMATION_DELIVERY_WARNING_TTL_MS）。
  const automationDeliveryWarningAtByKey = new Map<string, number>();
// 任务事件订阅表：key 是 taskId；value 既是 disposable，又暴露 automation/imInput 两个状态重置钩子
// （分别对应自动化触发与 IM 输入两类订阅者）。disposeAll 必须逐个释放（INV-12）。
  const streamSubscriptions = new Map<
    string,
    IDisposable & { automation(runId?: string): void; imInput(): void }
  >();
// 流事件分发中心：单条上游任务流扇出给多个订阅者，避免每个订阅者各开一次上游订阅。
  const taskStreamHub = createBotTaskStreamHub<ZCodeStreamEvent | TaskStreamMirrorableEvent>();
// 私聊发送失败的重试缓冲：保留原 message 与 bindingId。sending 标记防止重试协程与实时发送
// 同时打同一条消息——消息重复比延迟更糟。
  const failedPrivateDeliveries = new Map<
// bindingId 记录消息产生时的绑定：重发前比对，避免换绑后把旧回复发给新会话。
    string,
    {
      id: string;
      message: BotOutboundMessage;
      bindingId: string | undefined;
      taskId: string;
      sending: boolean;
    }
  >();
// 私聊重连/对账的单飞 Promise：同一 bot 并发触发只跑一份，避免重复补发。
  const privateReconciliations = new Map<string, Promise<void>>();
// 已转发的 IM trace 集合：按 traceId 去重，防止同一事件被两条订阅路径各转一次。
  const privateImTraces = new Set<string>();
// watcher 启动的单飞：持有进行中的 Promise，失败后由调用方清除以允许重试。
  const watchStarts = new Map<string, Promise<void>>();
// 已建立的 watcher 及签名：配置或 workspace 变化导致签名不同时需要重建。
  const privateWatches = new Map<string, { signature: string; key: string }>();
// [资源] 用 WeakSet 按事件对象身份去重而不是 Set：事件被上游释放后自动回收；
// 用 Set 会长期持有事件对象，内存随任务数单调增长。
  const forwardedTaskEvents = new WeakSet<object>();
// 私聊恢复定时器句柄；privateRecoveryPending 是重入闸门，防止上一轮未结束又起一轮。
  let privateRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  let privateRecoveryPending = false;
// [资源] INV-09：所有在途流式卡片请求的 AbortController；dispose 时统一 abort。
// 否则请求会在 15s 超时里悬着，dispose 之后回调仍可能写状态（违反 INV-12）。
  const streamingCardRequestControllers = new Set<AbortController>();
// 临时交互卡片（队列卡）句柄表：key 是投递作用域键，value 持有 bot/taskId/handle。
// 保留 taskId 是为了在任务终态时精确判断这张卡是否还属于当前任务。
  const transientInteractionCards = new Map<
    string,
    {
      bot: BotConfig;
      taskId: string;
      handle: BotTransientInteractionCardHandle;
    }
  >();
// typing 状态双表：typingIntervals 管定时器，typingTargets 管「往哪发」。
// [并发] 两表必须同增同删：只有 interval 没有 target 会在 tick 时找不到目标；
// 只有 target 没有 interval 则永远不再续期；dispose 漏清任一侧都会留下孤儿定时器（INV-12）。
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  const typingTargets = new Map<string, { bot: BotConfig; target: BotTypingTarget }>();
// 正在执行的任务 id：用于「同一任务不重复启动」与诊断计数，不承担入站幂等键职责。
  const runningTasks = new Set<string>();
// 话题续接状态机：每个话题线程一份，负责把连续输入排成有序队列并合并准备结果。
// value 用 ReturnType<typeof createTopicContinuation<...>>：模块升级时类型自动跟随，不会漂移。
  const topicContinuations = new Map<
    string,
    ReturnType<typeof createTopicContinuation<PreparedTopicMessage>>
  >();
// 已就绪的话题历史标识：记录「该话题已加载过历史」的判定，避免每次输入都重读。
  const topicHistoryReady = new Map<string, string>();
// 两个 epoch 表：botHistoryEpoch 在连接失效时自增（见 feishuRuntime 的 onConnectionInvalidated）；
// groupHistoryEpoch 在群级历史开关变化时自增。异步历史读取完成时比对 epoch，不一致即丢弃结果，
// 否则断线前的旧结果会覆盖断线后的新状态。
  const botHistoryEpoch = new Map<string, number>();
  const groupHistoryEpoch = new Map<string, number>();
// 话题停止的单飞 Promise：stop 是异步的（清卡片 + 落状态），重复 stop 复用同一个 Promise。
  const topicStops = new Map<string, Promise<void>>();
// topicPreparation 是跨话题共享的「正在准备历史」投影，由 broadcast 推给前端，不必每个话题各存一份。
  const topicPreparation = createTopicPreparationState();
// 准备态变化只发空 payload 的失效信号：前端自行重拉，避免广播里塞业务数据结构。
  const publishTopicPreparation = () =>
    deps.broadcastService?.send({ channel: "bots:group-state", payload: {} });
// 话题代次：话题上下文重建或授权变化时递增，用于丢弃过期的异步准备结果。
  const topicGenerations = new Map<string, number>();
// 待收齐的回复收集器：key 是话题线程，value 是「期望条数 → resolve」的回调表，用于合并分片回复。
  const topicReplies = new Map<string, Map<string, (replies: BotOutboundMessage[]) => void>>();

// live status 的最近一条推进文本：任务进行中高频刷新，只保留最新一条，避免堆积。
  const liveStatusProgressByTaskId = new Map<
// kind 只区分 message/thought/tool：渲染只需要前缀，不需要完整事件对象。
    string,
    { kind: "message" | "thought" | "tool"; text: string }
  >();
// 运行时状态（连接/投递错误）只存内存：它是瞬时观测值，落盘反而会在重启后显示过期状态。
  const runtimeByBotId = new Map<string, BotRuntimeInfo>();
// 待选择提示：同一会话同时只保留一个选择（新的覆盖旧的），避免用户对不上编号。
  const pendingSelectionsByContext = new Map<string, SelectionPrompt>();
  // 只读取任务订阅和运行状态的数量，不暴露消息内容。
// 内存诊断只登记计数回调，不暴露任何消息内容；由诊断端点按需调用，不在热路径产生开销。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("bots", () => ({
    streamSubs: streamSubscriptions.size,
    runningTasks: runningTasks.size,
    typingIntervals: typingIntervals.size,
    liveStatusProgress: liveStatusProgressByTaskId.size,
  }));
// 任务选择候选（key=上下文，二级 key=选项 id）：渲染与解析共用同一份，保证编号稳定。
  const pendingTaskSelectionsByContext = new Map<string, Map<string, BotTaskSelectionEntry>>();
// workspace 选择候选项，结构同上；分表是为了两类选择互不覆盖。
// 二级 map 而非复合字符串 key：选择项需要按上下文整批清理，嵌套结构更直接。
  const pendingWorkspaceSelectionsByContext = new Map<
    string,
    Map<string, BotWorkspaceSelectionEntry>
  >();
// 远端重连的单飞表：同一 key 的并发重连共用一次 ensureConnected。
  const pendingRemoteReconnectsByKey = new Map<string, Promise<BotOutboundMessage[]>>();
// 最近一次重连时间（3s 窗口，见 REMOTE_RECONNECT_DEDUPE_TTL_MS）。
  const recentRemoteReconnectAtByKey = new Map<string, number>();
// 重连后投递时间（2min 窗口）：防止重连风暴把同一条离线消息重发多遍。
  const recentRemoteReconnectDeliveryAtByKey = new Map<string, number>();
// INV-03 入站幂等键 → 占位时间。必须在副作用之前写入，失败路径要删除，否则消息被永久吞掉。
// 只存时间戳而不是完整 payload：窗口滑动与内存占用都可控。
  const recentInboundDeliveryAtByKey = new Map<string, number>();
// 每个上下文一条串行处理链：保证同一会话的入站消息按到达顺序处理（否则「先选模型再发任务」会乱序）。
// 串行是 per-context 而不是全局：不同会话之间不应互相阻塞。
  const inboundProcessingQueuesByContext = new Map<string, Promise<void>>();
// bot 存储迁移的单飞 Promise：并发读都等同一份迁移完成，避免重复搬迁或互相覆盖。
  let botStorageMigrationPromise: Promise<void> | null = null;
// locale 缓存：语言是低频变更的配置；每次渲染都读 repo 会把读盘放大到消息量级。
  let cachedLocale: Locale | undefined;
// provider 适配器表用 Record<BotProvider, ...> 而不是 Partial：新增 provider 枚举值时，
// 这里必须显式给值（未实现就写 null），编译期强制面对「新 provider 怎么处理」。
// [权衡] onDeliveryResult 在函数声明之前引用是安全的（函数声明提升）；
// 若改成 const 箭头函数，这里会落进 TDZ 直接抛 ReferenceError。
  const providers: Record<BotProvider, BotProviderAdapter | null> = {
// loadCredential 用闭包按 key 现取：adapter 不持有凭据值，缩短明文在内存中的生命周期。
    telegram: createTelegramBotProvider({
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    webhook: createWebhookBotProvider({
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    feishu: createFeishuBotProvider({
      onDeliveryResult,
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    lark: createFeishuBotProvider({
      onDeliveryResult,
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    weixin: createWeixinBotProvider({
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    discord: null,
    wecom: null,
  };
// service 先声明后赋值：内部很多函数（如 processProviderCallback）引用 service，闭包按引用读取，
// 只要赋值发生在运行时调用之前即可，避免用 any 绕过类型检查。
  let service: IBotsService & {
    disposeAll(): void;
    disposeAllAndWait(): Promise<void>;
  };
// dispose 门闩：disposeAll 与 disposeAllAndWait 共用，重复调用复用同一 Promise（INV-12）。
  let shutdownPromise: Promise<void> | null = null;

// 投递结果回调：把「回复是否投递成功」写进 runtime 状态，但不改连接状态。
// 把投递错误当连接错误会让 UI 显示 bot 掉线，并触发无意义的重连风暴。
  function onDeliveryResult(bot: BotConfig, deliveryError: string | undefined): void {
    // 收消息正常不代表回复已投递，不能把投递错误混成连接错误。
    const current = runtimeByBotId.get(bot.id);
// 状态取当前值；首次投递失败时按 enabled 推导 idle/disabled，保证也有可展示状态。
    setRuntimeStatus({
      botId: bot.id,
      provider: bot.provider,
      status: current?.status ?? (bot.enabled ? "idle" : "disabled"),
// deliveryError 为 undefined 表示本次成功：只有仍存在失败缓冲时才保留旧错误，否则清空。
      deliveryError:
        deliveryError ?? (failedPrivateDeliveries.has(bot.id) ? current?.deliveryError : undefined),
    });
  }

// 合并写入并刷新 lastUpdateAt：调用方只传差异字段，避免覆盖未变更的连接状态。
  function setRuntimeStatus(status: BotRuntimeInfo): void {
    runtimeByBotId.set(status.botId, {
      ...runtimeByBotId.get(status.botId),
      ...status,
      lastUpdateAt: Date.now(),
    });
  }

// statusSink 是 channel runtime 写运行状态的唯一回调面：runtime 不直接持有 map，便于替换与测试。
  const statusSink = {
    getRuntimeStatus(botId: string) {
      return runtimeByBotId.get(botId);
    },
    setRuntimeStatus,
  };
// Telegram runtime：长轮询循环 + offset 持久化 + 后台任务开关。
// readConfig 传 thunk 而不是值：每轮都读最新配置，否则改配置要重启才生效。
  const telegramRuntime = createTelegramChannelRuntime({
// runBackgroundTasks 透传给 runtime，由 runtime 决定是否起轮询，而不是在这里 if 包住整个工厂。
    runBackgroundTasks: runStartupBackgroundTasks,
    credentialService: deps.credentialService,
    telegramProvider: providers.telegram,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated,
    readConfig: () => repo.readConfig(),
    readTelegramOffset,
    writeTelegramOffset,
    processProviderCallback,
  });
// 微信 runtime：同一套骨架，差异在游标字段（weixinGetUpdatesBuf）与扫码登录。
  const weixinRuntime = createWeixinChannelRuntime({
    runBackgroundTasks: runStartupBackgroundTasks,
    credentialService: deps.credentialService,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated,
    readConfig: () => repo.readConfig(),
    readWeixinGetUpdatesBuf,
    writeWeixinGetUpdatesBuf,
    processProviderCallback,
  });
// 飞书 runtime：事件回调 + 应用注册 + 连接失效通知。
// onConnectionInvalidated 自增 botHistoryEpoch：断线期间的历史读取结果已不可信，
// 必须让在途请求的完成回调识别出 epoch 变了而丢弃（见 epoch 表说明）。
  const feishuRuntime = createFeishuChannelRuntime({
    runBackgroundTasks: runStartupBackgroundTasks,
    credentialService: deps.credentialService,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated,
    readConfig: () => repo.readConfig(),
    summarizeCallbackPayload,
    onConnectionInvalidated: (botId) =>
      botHistoryEpoch.set(botId, (botHistoryEpoch.get(botId) ?? 0) + 1),
    processProviderCallback,
  });

// 游标与其它 bot 状态存在同一个 BotContextState 里，不单独落文件；写入天然经过 serializeStateWrite（INV-02）。
  async function readTelegramOffset(botId: string): Promise<number | undefined> {
// 游标读不加锁：单次拿到的是完整快照，调用方只用它跳过已处理更新，不需要强一致。
    return (await repo.readState()).bots[botId]?.telegramOffset;
  }

// offset 语义是「已处理到的位置」：先处理消息再写 offset；重复投递由入站幂等键兜住（INV-03）。
  async function writeTelegramOffset(botId: string, offset: number): Promise<void> {
    await updateProviderCursor(botId, { telegramOffset: offset });
  }

  async function readWeixinGetUpdatesBuf(botId: string): Promise<string | undefined> {
    return (await repo.readState()).bots[botId]?.weixinGetUpdatesBuf;
  }

  async function writeWeixinGetUpdatesBuf(botId: string, buf: string): Promise<void> {
    await updateProviderCursor(botId, { weixinGetUpdatesBuf: buf });
  }

// 游标写入：先确认 bot 仍存在，再取（或创建）私聊上下文，最后在串行链里做字段级 merge。
// 只 patch 两个游标字段与 updatedAt，不整份覆盖，避免把并发写入的任务状态冲掉。
  async function updateProviderCursor(
    botId: string,
    patch: Pick<BotContextState, "telegramOffset" | "weixinGetUpdatesBuf">,
  ): Promise<void> {
    const bot = findBot(await repo.readConfig(), botId);
    if (!bot) return;
// readContext 有副作用：私聊上下文不存在时会创建。这里接受该副作用，因为它顺带完成迁移与
// workspace 绑定；返回 null 表示 bot 已停用或没有可用 workspace。
    const context = await readContext(
      {
        botId,
        chatType: "private",
        provider: bot.provider,
        providerUserId: bot.providerUserId ?? "",
      },
      bot,
    );
    if (!context) return;
// 回调返回 undefined 表示「当前不存在就不写」：游标写入不负责创建上下文。
    await serializeStateWrite(async () => {
      await repo.updateContext(botId, (current) =>
        current ? { ...current, ...patch, updatedAt: Date.now() } : undefined,
      );
    });
  }

// 读取（必要时创建）会话上下文。三条分支的优先级如下：
// 1) 已有持久上下文：只做旧格式修复，绝不重建；
// 2) 群/话题：从父群上下文派生，授权继承但任务状态清零；
// 3) 私聊：按允许的 workspace 绑定项目，生成草稿上下文。
// 任何分支都先 ensureBotStorageMigrated，保证读到的键格式是当前版本。
  async function readContext(actor: BotActor, bot: BotConfig): Promise<BotContextState | null> {
// 迁移单飞：并发首读不会各自跑一遍迁移（见 botStorageMigrationPromise）。
    await ensureBotStorageMigrated();
// 一次读取整份 state：后续判定都基于同一快照，避免中途被别人改写。
    const state = await repo.readState();
// 会话键由 getBotConversationKey 统一生成（含 threadId），本文件不自己拼字符串。
    const existing = state.bots[getBotConversationKey(actor)];
// existing 分支不再校验 bot.enabled：停用 bot 的历史上下文仍需可读（用于退订/清理），
// 投递侧另有 enabled 判定，不会因为可读就发出消息。
    if (existing) {
// hostId 已存在视为「新格式」直接返回，不再猜 workspace source（见下一行注释）。
      if (existing.hostId !== undefined) return existing;
      // 旧 SSH alias 必须先由可信 Host 解析，再匹配项目；不能以相同路径猜测 Source。
// [失败路径] normalizeWorkspaceRef 走可信 host 解析，失败时抛错而不是退回同路径猜测；
// 宁可本次读失败（上层可提示），也不能把远端路径误判成本地 workspace 去执行任务。
      const resolved = await normalizeWorkspaceRef(
        createWorkspaceRef(existing.workspacePath, existing.workspaceIdentity),
      );
// upgradeLegacyContext 只补字段、不改授权；catalog 提供项目归属用于填 projectId/hostId。
      const next = upgradeLegacyContext(
        {
          ...existing,
          workspacePath: resolved.workspacePath,
          workspaceIdentity: resolved.workspaceIdentity,
        },
        await readProjectCatalog(deps),
      );
      return (
// 写回采用 compare-and-set 语义：只有当前仍是旧格式（hostId 未定义）才覆盖；
// 否则说明并发读已经修好，直接返回它写的结果，避免两份升级互相覆盖。
        (await repo.updateContext(getBotConversationKey(actor), (current) =>
          current?.hostId !== undefined ? current : { ...current, ...next },
        )) ?? null
      );
    }
// 群消息必须落在某个线程里才有「话题」身份；群主线程的上下文由父级承载，不在这里创建。
    if (actor.chatType === "group") {
      if (!actor.threadId) return null;
// 父级键 = 去掉 threadId 的同一个群会话：话题的授权与 workspace 只能从群主上下文继承。
      const parent =
        state.bots[
          getBotConversationKey({ ...actor, threadId: undefined, conversationThreadId: undefined })
        ];
// INV-01：父群必须启用，且 ownerId 必须等于该 bot 的 providerUserId。
// 任一不满足就返回 null（不建上下文），任何消息文本都不参与这里的判定。
      if (!parent?.group?.enabled || parent.group.ownerId !== bot.providerUserId) return null;
      let topicTitle = actor.topicTitle;
      let topicUrl = actor.topicUrl;
      let rootMessageId = actor.rootMessageId;
// 原生事件没带标题时尝试向 provider 补取；这是可选增强，失败不影响话题可用。
      if (!topicTitle && actor.providerMessageId) {
        try {
// resolveTopic 可能需要额外读取权限；返回 undefined 表示该 provider 不支持。
          const resolved = await providers[bot.provider]?.resolveTopic?.(bot, actor);
          topicTitle = resolved?.topicTitle;
          topicUrl = resolved?.topicUrl;
          rootMessageId = resolved?.rootMessageId ?? rootMessageId;
// [失败路径] 补取失败只降级标题（用 threadId 兜底），不扩大历史读取范围，也不把异常抛给调用方：
// 话题本身已可用，授权不足属于能力缺失而非错误（INV-06）。
        } catch {
          // 原生事件已带话题身份时，缺少额外读取权限仅影响标题；不扩大历史读取范围。
          topicTitle = actor.threadId;
        }
      }
      // 话题只继承配置快照；不能复制默认任务的输入、问答或审批授权。
// 话题上下文：workspace 与授权继承父群，任务相关字段全部重置。
      const topic: BotContextState = {
        botId: bot.id,
        workspacePath: parent.workspacePath,
        workspaceIdentity: parent.workspaceIdentity,
// 只继承 workspace 四元组与附加目录：这些是用户显式配置，不随话题变化。
        workspaceId: parent.workspaceId,
        projectId: parent.projectId,
        hostId: parent.hostId,
// additionalDirectories 也继承：它属于 workspace 配置，不是任务状态。
        additionalDirectories: parent.additionalDirectories,
// mode 固定 draft 且 activeTaskId=null：话题需要自己的草稿任务，不能复用群里正在跑的任务。
        mode: "draft",
        activeTaskId: null,
        updatedAt: Date.now(),
// draftOptions 继承父级的「非任务态」选项，但 mode 强制 default，避免把父级运行模式带进话题。
        draftOptions: { ...(await buildActiveTaskDraftOptions(parent)), mode: "default" },
        group: {
          chatId: parent.group.chatId,
          threadId: actor.threadId,
          rootMessageId,
          topicTitle,
          topicUrl,
          name: parent.group.name,
          ownerId: parent.group.ownerId,
          enabled: true,
          authorizationId: parent.group.authorizationId,
// taskIds 从空开始：话题任务历史独立，父级任务列表带过来会让卡片指向别人的任务。
          taskIds: [],
// currentOptions 同样复制父级群配置并重置 mode；模型/思考等级属于群级偏好，可以继承。
          currentOptions: { ...parent.group.currentOptions, mode: "default" },
        },
      };
// [并发] INV-02：占位与写入都在串行链内完成，且链内重新读取最新 state。
      await serializeStateWrite(async () => {
        const latest = await repo.readState();
// 重新读：外面的快照可能已被别人改过（例如群刚被停用）。
        const currentParent = latest.bots[getBotStateKey(parent)];
        const key = getBotStateKey(topic);
// 三个放弃条件：话题已存在（幂等重入）、父群已停用、父群授权已变（旧事件）。
// 任一成立就不写，防止旧消息把已撤销的话题复活。
        if (
          latest.bots[key] ||
          !currentParent?.group?.enabled ||
          currentParent.group.authorizationId !== topic.group!.authorizationId
        )
          return;
        latest.bots[key] = topic;
// 直接改内存快照再整体 writeState：repo 保证原子落盘（INV-10）。
        await repo.writeState(latest);
      });
// 以落盘结果为准返回：若刚才是并发方写入，这里读到的是它的版本（INV-10）。
      return (await repo.readState()).bots[getBotStateKey(topic)] ?? null;
    }
// 私聊首次进入：从允许列表取第一个可用 workspace，再绑定项目。
// 取之前先规范化允许列表：配置里可能写过已不存在的 workspace，不规范化会把失效项当成「有配置」，
// 于是直接返回 null，用户永远建不出上下文。
    const workspaces = await listWorkspaceRefs();
    const workspace = firstAllowedWorkspace(workspaces, {
      ...bot,
      allowedWorkspaces: normalizeConfiguredAllowedWorkspaces(bot.allowedWorkspaces, workspaces),
    });
    if (!workspace) return null;
// bindProject 会 prepareSession（唯一写路径），只在新上下文时调用，绝不在每次读时重复绑定。
    const execution = await bindProject(workspace);
// 新私聊上下文：mode draft、无活动任务；draftOptions 由绑定结果推导（模型/目录）。
    const context: BotContextState = {
      botId: bot.id,
// 展开 execution：bindProject 产出 workspacePath/workspaceIdentity/workspaceId/projectId/hostId。
// 话题分支只复制同样几个字段，保证两条路径产出的上下文形状一致。
      ...execution,
      mode: "draft",
      activeTaskId: null,
      draftOptions: await buildInitializedDraftOptions(execution),
      updatedAt: Date.now(),
    };
    return (
// 写回同样用 CAS：只有仍是旧格式才覆盖，防止并发首读互相覆盖 privateBindingId。
      (await repo.updateContext(bot.id, (current) =>
        current?.hostId !== undefined ? current : { ...current, ...context },
      )) ?? null
    );
  }

// [并发] INV-02 的唯一串行点：所有「读 state → 改 → 写 state」都必须挂到这条尾巴上。
// 每次把 next 续到 tail 之后，并用 catch 吞掉前一次的失败：否则一次写入失败会让后续所有
// 写入跟着拒绝，服务进入永久只读。
  let stateWriteTail: Promise<void> = Promise.resolve();
// 队列卡作用域读取：key 是 JSON 元组（botId/chatId/taskId/authorizationId/inputId/threadId）。
// 返回 undefined 表示「这张卡不该再被读写」，六个条件缺一即可：bot 启用、群启用、owner 仍是该 bot、
// 授权未变、活动任务未变、输入属于该任务。
// 它们共同维护 INV-01（旧卡不能改写授权）与 INV-07（终态不丢、旧卡必须失效）。
  async function readQueueCardScope(key: string) {
// [失败路径] 不 try/catch：key 只由本文件生成，解析失败即编码 bug，应当直接暴露。
    const [botId, chatId, taskId, authorizationId, inputId, threadId] = JSON.parse(key) as string[];
    const state = await repo.readState();
    const context =
      state.bots[getBotConversationKey({ botId: botId!, chatType: "group", chatId, threadId })];
    const bot = findBot(await repo.readConfig(), botId!);
    const input = context?.group?.inputs?.[inputId!];
    if (
      !bot?.enabled ||
      !context?.group?.enabled ||
      context.group.ownerId !== bot.providerUserId ||
      context.group.authorizationId !== authorizationId ||
// 六个条件必须在同一份 state 快照上判定：拆成多次读会漏掉「授权刚被换掉」的窗口。
      context.activeTaskId !== taskId ||
      input?.taskId !== taskId
    )
      return undefined;
    return { state, context, bot, input };
  }
  const queueCards = createGroupQueueCardSync({
// read 只读 progress：渲染方拿不到 bot/context，避免误用在渲染路径里写状态。
    read: async (key) => (await readQueueCardScope(key))?.input.progress ?? undefined,
// mutate：串行链内重新取作用域（防 TOCTOU），再整份 writeState。
    mutate: async (key, update) => {
// update 的返回值既写回内存快照也随 writeState 落盘：同一个对象，渲染与持久化不会出现两种状态。
      let result: BotGroupInputProgress | undefined;
      await serializeStateWrite(async () => {
        const scope = await readQueueCardScope(key);
        if (!scope) return;
// 缺省 progress 视为 waiting：新输入尚未被 admission 推进时的初始态。
        result = update(scope.input.progress ?? { status: "waiting" });
        scope.input.progress = result;
        await repo.writeState(scope.state);
      });
      return result;
    },
// render：把状态映射成本地化短文本并 patch 卡片。
    render: async (key, providerMessageId, status) => {
      const scope = await readQueueCardScope(key);
      // 话题复用单向状态记录，但不渲染或更新历史遗留排队卡。
      if (!scope || scope.context.group?.threadId) return;
// locale 每次现读：用户可能中途切语言，卡片文案要跟随（缓存见 cachedLocale）。
      const english = (await readMessageLocale()) === "en-US";
// 状态表按 BotGroupInputStatus 全量覆盖：新增状态漏写会编译失败，而不是运行时渲染空串。
      const text: Record<BotGroupInputStatus, string> = english
        ? {
            waiting: "Waiting to run",
            working: "Running",
            done: "Completed",
            failed: "Failed",
            stopped: "Stopped",
            cancelled: "Cancelled",
            discarded: "Not executed",
          }
        : {
            waiting: "等待执行",
            working: "正在执行",
            done: "已完成",
            failed: "执行失败",
            stopped: "已停止",
            cancelled: "已取消",
            discarded: "未执行",
          };
// adapter 必须支持 updateTransientInteractionCard；不支持说明该 provider 未实现队列卡。
// 两种语言并列内联而不走 messages 字典：这是状态枚举到短文案的直接映射，缺一个状态编译期即可发现。
      const adapter = providers[scope.bot.provider];
// [失败路径] 抛错交给 queueCards 内部捕获并降级（best-effort 渲染），不影响输入执行。
      if (!adapter?.updateTransientInteractionCard)
        throw new Error("Queue card update unavailable");
      await adapter.updateTransientInteractionCard(
        scope.bot,
        { providerMessageId },
        {
          botId: scope.bot.id,
          provider: scope.bot.provider,
          providerUserId: scope.context.group!.chatId,
          text: text[status],
        },
      );
    },
  });
// 串行化状态写入的唯一入口，三个要点：
// - next = tail.catch(...).then(op)：前一次失败不阻断下一次；
// - stateWriteTail 立刻指向 next，后续调用必然排在本次之后；
// - 返回 next，让调用方能感知自己的写入失败（内部不能静默吞错）。
  function serializeStateWrite(operation: () => Promise<void>): Promise<void> {
    const next = stateWriteTail.catch(() => undefined).then(operation);
    stateWriteTail = next;
    return next;
  }
// 保存 bot 配置（对外入口）。顺序：先落配置，再修状态，最后做失效与对账。
// [事务] 两步不在同一事务里：若在「配置已写、状态未修」之间崩溃，会留下「绑定已变但群授权仍旧」
// 的中间态；下次保存会重走修复，但期间旧授权仍可用。这个窗口本函数无法消除（repo 只保证单次写原子）。
  async function writeBotConfig(next: BotsConfigFile): Promise<BotsConfigFile> {
// 收集需要取消在途话题准备的 actor，等状态写完后统一取消（原因见后面对应注释）。
    const invalidatedTopics: BotActor[] = [];
// 先读 previous：写 config 后旧值就取不到了，而换绑判定必须同时持有前后两份。
    const previous = await repo.readConfig();
    const saved = await repo.writeConfig(next);
// 绑定身份变化字段：providerUserId/provider/feishuAppId/credentialRef 任一变化，
// 都意味着「同一个 bot 换了入口或凭据」，旧会话的收件人与授权必须失效。
    const changedBindings = new Set(
// 只看 previous 侧：新增 bot 没有旧绑定，不需要让任何已存在的东西失效。
      previous.bots
        .filter((before) => {
          const after = saved.bots.find((bot) => bot.id === before.id);
          return (
            !after ||
            before.providerUserId !== after.providerUserId ||
            before.provider !== after.provider ||
            before.feishuAppId !== after.feishuAppId ||
            before.credentialRef !== after.credentialRef
          );
        })
        .map((bot) => bot.id),
    );
// 状态修复排在既有写入链之后：不插队，否则会读到别人正在改的中间态。
    const operation = stateWriteTail
      .catch(() => undefined)
      .then(async () => {
// 读最新 state 而不是复用写配置前的快照：期间状态可能已被任务回写改过。
        const state = await repo.readState();
        let changed = false;
// 遍历全部上下文（私聊 + 群 + 话题），按 bot 维度决定要不要作废。
        for (const [key, context] of Object.entries(state.bots)) {
// 没有 group 的上下文是私聊；有 group.threadId 的才是话题，两类失效规则不同。
          const group = context.group;
          if (!group) {
// 私聊上下文：换绑或启用状态变化时轮换 privateBindingId，让旧的在途投递自然失效。
            const before = previous.bots.find((item) => item.id === context.botId);
            const after = saved.bots.find((item) => item.id === context.botId);
// 启用状态变化也要轮换：重新启用时不能复用停用期间的绑定，否则旧消息可能被投递。
            if (changedBindings.has(context.botId) || before?.enabled !== after?.enabled) {
// 改的是副本（state.bots[key] = {...context}）：调用方的 context 不被污染，后续仍可安全使用。
              if (
                changedBindings.has(context.botId) &&
// 微信凭据 key 含收件人；换绑时必须删旧 key，否则凭据表会留下孤儿条目。
                before?.provider === "weixin" &&
                context.privateRecipientId
              )
                await deps.credentialService.delete(
                  weixinContextKey(before, context.privateRecipientId),
                );
// [权衡] 换绑时显式置 privateRecipientId=undefined 而不是保留：旧收件人可能属于上一个账号。
              state.bots[key] = {
                ...context,
                privateBindingId: randomUUID(),
// 只在本轮 changedBindings 命中时清 privateRecipientId；单纯启停不清，避免误删仍可用的收件人。
                ...(changedBindings.has(context.botId) ? { privateRecipientId: undefined } : {}),
              };
              changed = true;
            }
            continue;
          }
// 有 group 的上下文统一换授权：群主上下文与话题子上下文都要失效。
          const current = saved.bots.find((bot) => bot.id === context.botId);
// 未换绑且 owner 仍匹配的群上下文直接跳过：绝大多数保存不会触碰群授权。
          if (!changedBindings.has(context.botId) && current?.providerUserId === group.ownerId)
            continue;
          const originalBot = previous.bots.find((bot) => bot.id === context.botId);
// 只有话题线程需要记入失效列表（主群上下文自己会被下面直接关闭）。
          if (group.threadId && originalBot)
            invalidatedTopics.push({
              botId: context.botId,
              provider: originalBot.provider,
              chatType: "group",
              chatId: group.chatId,
              threadId: group.threadId,
              providerUserId: group.ownerId,
            });
// 群上下文作废：enabled=false + 换新 authorizationId，并把所有非 sent 投递标记 invalidated。
// sent 保留原状——已送达不可撤回，标成 invalidated 只会让统计失真（INV-07）。
          state.bots[key] = {
            ...context,
            group: {
              ...group,
              enabled: false,
              authorizationId: randomUUID(),
// 投递表逐条转换而不是整体丢弃：已送达记录必须留着才能回答「结果到底发出去没有」。
              deliveries: Object.fromEntries(
                Object.entries(group.deliveries ?? {}).map(([id, result]) => [
                  id,
// 只有 sent 视为终态；其余（含 sending/failed）一律失效，因为任务已不属于这个群。
                  result.status === "sent" ? result : { ...result, status: "invalidated" as const },
                ]),
              ),
            },
          };
          changed = true;
        }
        if (changed) await repo.writeState(state);
      });
// 先占位再 await：即便本次操作失败，后续写入也必须排在它之后。
    stateWriteTail = operation;
    await operation;
    // 授权变更还必须失效尚未提交的材料，不能等旧准备返回后再生成回复。
// 取消在途话题准备必须发生在状态写完之后：否则旧准备可能先返回并读到仍有效的旧授权。
    await Promise.all(invalidatedTopics.map(cancelTopicInputs));
    if (changedBindings.size)
      await deps.broadcastService
        ?.send({ channel: "bots:group-state", payload: {} })
        .catch(() => undefined);
// 对「保存前后出现过的所有 bot」做私聊对账：停用的 bot 也需要清理订阅与 typing（INV-12）。
    for (const botId of new Set([...previous.bots, ...saved.bots].map((item) => item.id)))
      await reconcilePrivateSynchronization(botId);
    return saved;
  }

// 写入会话上下文（内部最常用的写路径）。与 writeBotConfig 的区别：
// 这里做字段级合并 + 代次校验，以持久状态为权威（INV-02/INV-10）。
// updateAuthorization=true 只在群授权真正变更时使用，会连带失效该群所有话题卡片。
// expectedTaskId 是 CAS 条件：非 undefined 时，只有仍是该任务/该绑定才允许写。
  async function writeContext(
    context: BotContextState,
    updateAuthorization = false,
    expectedTaskId?: string | null,
  ): Promise<void> {
    const next = stateWriteTail
// 回调里重新读 state：调用方传入的 context 只是「意图」，不是权威快照。
      .catch(() => undefined)
      .then(async () => {
        const state = await repo.readState();
// 键取自 getBotStateKey：群/话题用 chat+thread，私聊用 bot+用户，两套键不能混用。
        const key = getBotStateKey(context);
        const latest = state.bots[key];
        const latestGroup = latest?.group;
// 私聊 CAS 守卫：expectedTaskId 与 privateBindingId 任一不符就放弃写入。
// 典型场景：换绑或切换任务后，旧事件的处理结果迟到，绝不能把状态写回旧绑定。
        if (
          !context.group &&
          expectedTaskId !== undefined &&
          (latest?.activeTaskId !== expectedTaskId ||
// privateBindingId 也参与比对：换绑后即使任务 id 相同，也不允许旧事件写回。
            latest?.privateBindingId !== context.privateBindingId)
        )
          return;
        // 群事件可能在停用、换绑或切换任务前开始处理；旧事件不能恢复已经撤销的关联。
// 群的过期守卫：授权 id 已变或活动任务已变，说明这是旧事件，直接丢弃（INV-01）。
        if (
          context.group &&
          !updateAuthorization &&
          latestGroup &&
          (latestGroup.authorizationId !== context.group.authorizationId ||
            (expectedTaskId !== undefined && latest?.activeTaskId !== expectedTaskId))
        )
          return;
// 合并群字段：以 latest 为权威，只接受 context 里的「累加型」变化。
        const group =
          context.group && latestGroup && !updateAuthorization
            ? {
// enabled/ownerId/authorizationId 一律取 latest：任何旧快照都不能把授权放宽。
                ...context.group,
                enabled: latestGroup.enabled,
// 刻意不用 context.group 的 enabled/ownerId：它们来自事件发生时的旧快照。
                ownerId: latestGroup.ownerId,
                authorizationId: latestGroup.authorizationId,
                // 其他话题可能已更新群级历史开关，旧输入回写不能覆盖最新配置。
                historyEnabled: latestGroup.historyEnabled,
                topicActive: latestGroup.topicActive ?? context.group.topicActive,
// taskIds 取并集：同一群可能同时有多个话题在跑任务，覆盖会丢卡片的任务归属。
                taskIds: [...new Set([...latestGroup.taskIds, ...context.group.taskIds])],
                // 已确认的 admission 是终态，迟到的流事件不能写回 pending。
// inputs 按 id 逐个决定谁更新，而不是整表替换。
                inputs: Object.fromEntries(
                  Object.entries({ ...latestGroup.inputs, ...context.group.inputs }).map(
                    ([id, input]) => {
                      const latestInput = latestGroup.inputs?.[id];
// 已 accepted/rejected 的 admission 是终态：迟到的流事件不能把它改回 pending（INV-04）。
                      const selected =
                        latestInput?.admission === "accepted" ||
                        latestInput?.admission === "rejected"
                          ? latestInput
                          : input;
                      // 流事件可能先于 admission 返回；写回接收结果时保留已推进的卡片状态。
                      return [
                        id,
// progress 一律取 latest：卡片推进只允许前进，旧快照的 waiting 不能把已完成刷回去。
                        { ...selected, progress: latestInput?.progress ?? selected.progress },
                      ];
                    },
                  ),
                ),
// taskWorkspaces 同样取并集：任务结束不删映射，避免历史卡片找不到 workspace。
                taskWorkspaces: { ...latestGroup.taskWorkspaces, ...context.group.taskWorkspaces },
// topicAliases/deliveries 只认 latest：它们是投递幂等的权威表（INV-07），不能被旧快照覆盖。
                topicAliases: latestGroup.topicAliases,
                deliveries: latestGroup.deliveries,
              }
            : context.group;
        // 自动互答次数由入口串行持久化；迟到的任务/授权回写不能用旧快照恢复额度。
// autoReplyGuard 由入口串行更新；旧快照写回会把已消耗的额度复活（防自动互答刷屏）。
        if (group && latestGroup?.autoReplyGuard) group.autoReplyGuard = latestGroup.autoReplyGuard;
        // 背景检查点由入口/接收提交更新，旧任务快照不能覆盖或复活它。
// backgroundHistory 是群级检查点：任务回写只能读它，不能推进或清空。
        if (group && latestGroup) group.backgroundHistory = latestGroup.backgroundHistory;
// 群停用或活动任务已切换：把未送达投递标成 invalidated，防止旧任务结果投到新任务卡片上。
        if (group && (!group.enabled || state.bots[key]?.activeTaskId !== context.activeTaskId)) {
// 逐条保留已送达：只把未送达标失效，终态信息不因任务切换而丢失（INV-07）。
          group.deliveries = Object.fromEntries(
            Object.entries(group.deliveries ?? {}).map(([id, entry]) => [
              id,
              entry.status === "sent" ? entry : { ...entry, status: "invalidated" as const },
            ]),
          );
        }
// taskIds 必须包含当前活动任务：渲染端据此判断任务是否仍属于这个群。
        const taskIds =
          group && context.activeTaskId
            ? [...new Set([...group.taskIds, context.activeTaskId])]
            : group?.taskIds;
        state.bots[key] = {
// 先铺 context 再用 latest 覆盖游标/绑定：显式列出哪些字段以磁盘为准，读代码不用猜。
          ...context,
// 游标取 latest：offset 只能前进，旧上下文回写不能把它推回已消费的位置。
          telegramOffset: latest?.telegramOffset ?? context.telegramOffset,
          weixinGetUpdatesBuf: latest?.weixinGetUpdatesBuf ?? context.weixinGetUpdatesBuf,
// privateBindingId 规则：任务与 workspace 都没变时沿用 latest（或补一个新 uuid）；
// 任一变化就换新 id，让旧的在途投递失效——否则重发的旧消息会打到新绑定的任务上。
          ...(!group
            ? {
                privateBindingId:
                  latest?.activeTaskId === context.activeTaskId &&
// 比较 workspace key 而不是路径字符串：远端与本地可能同路径不同源（INV-05）。
                  getWorkspaceKey(latest.workspacePath, latest.workspaceIdentity) ===
                    getWorkspaceKey(context.workspacePath, context.workspaceIdentity)
                    ? (latest.privateBindingId ?? randomUUID())
                    : randomUUID(),
              }
            : {}),
          ...(group
            ? {
                group: {
                  ...group,
                  taskIds: taskIds!,
                  taskWorkspaces: {
                    ...group.taskWorkspaces,
                    ...(context.activeTaskId
                      ? {
                          [context.activeTaskId]: {
                            workspacePath: context.workspacePath,
                            workspaceIdentity: context.workspaceIdentity,
                          },
                        }
                      : {}),
                  },
                },
              }
            : {}),
          updatedAt: Date.now(),
        };
// 群授权变更（updateAuthorization）：停用/换绑必须在同一次落盘内让该群所有话题失效。
// 逐个话题同步 enabled/ownerId/authorizationId 并作废未送达投递，
// 这样崩溃后不会出现「主群已停用、话题仍可投递」的裂缝（INV-01/INV-07）。
        if (updateAuthorization && group && !group.threadId) {
          // 群授权是单一权威；停用或换绑必须在同一次写入中使所有话题卡片失效。
// 只处理同 bot + 同群 + 有 threadId 的上下文：私聊与群主上下文不走这条路径。
          for (const [topicKey, topic] of Object.entries(state.bots)) {
            if (
              topic.botId !== context.botId ||
              topic.group?.chatId !== group.chatId ||
              !topic.group.threadId
            )
              continue;
// 先停同步再改状态：同步循环会写群状态，顺序反了会把刚写的失效状态覆盖回去。
            stopGroupSynchronization(topic);
// 直接改 state.bots 里的对象，随后整份落盘；不逐个调 writeContext，避免重入串行链造成自等待。
            state.bots[topicKey] = {
              ...topic,
              group: {
                ...topic.group,
                enabled: group.enabled,
                ownerId: group.ownerId,
                authorizationId: group.authorizationId,
                deliveries: Object.fromEntries(
                  Object.entries(topic.group.deliveries ?? {}).map(([id, result]) => [
                    id,
                    result.status === "sent"
                      ? result
                      : { ...result, status: "invalidated" as const },
                  ]),
                ),
              },
            };
          }
        }
// 单次 writeState：上面所有修改（主群 + 全部话题）在同一份 state 里落盘，repo 保证原子（INV-10）。
        await repo.writeState(state);
      });
// 与 writeBotConfig 一致：先占位再 await，保证调用顺序即落盘顺序。
    stateWriteTail = next;
// 写失败会让整个 writeContext 拒绝：调用方必须能感知，不能静默丢掉一次任务状态更新。
    await next;
// 私聊写完后的补偿：privateBindingId 以磁盘为准回填到入参对象（调用方随后可能继续用它），
// 再触发一次对账，把 watcher 与订阅对齐到最新绑定。
    if (!context.group) {
// 以磁盘回读为准：并发写可能刚改过 privateBindingId，内存里的旧值不可信（INV-10）。
      context.privateBindingId = (await repo.readState()).bots[context.botId]?.privateBindingId;
      await reconcilePrivateSynchronization(context.botId);
    }
// 群写入后广播群状态（只带 botId/chatId，不带状态体）：前端按需重拉，避免广播负载随群规模膨胀。
// 广播失败被 catch 掉是刻意的：状态已落盘，推送只影响刷新时机，不能让推送失败回滚一次成功写入。
    if (context.group)
      await deps.broadcastService
        ?.send({
          channel: "bots:group-state",
          payload: { botId: context.botId, chatId: context.group.chatId },
        })
        .catch(() => undefined);
  }

  function privateSyncSupported(bot: BotConfig): boolean {
    // [权衡] 白名单而非黑名单：新增 provider 默认不同步，漏同步只会退化成没有实时进度；
    // 误同步则会对未知渠道发起推送，可能触发平台限频或封号，两者代价不对称，故选保守一侧。
    return ["feishu", "lark", "telegram", "weixin"].includes(bot.provider);
  }

  // 任务流订阅键 = workspace + taskId + 会话身份。三段分别防三类冲突。
  // [并发] 必须带 workspace：同一 taskId 在本地与远端工作区可能重名，缺这段会让两处订阅
  // 命中同一个 key，后建的一方 dispose 掉先建的一方；必须用会话 key 而不是 botId：
  // 一个 bot 可同时服务多个群，只按 botId 建键会让第二个群接入时抢走第一个群的订阅。
  function taskStreamKey(context: BotContextState, actor: BotActor): string {
    return [
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      context.activeTaskId,
      getBotConversationKey(actor),
    ].join("::");
  }

  // 单聊订阅的对账入口：同一 botId 的多次调用串行排队，后一次必须等前一次（含失败）结束后再跑。
  // [并发] INV-02：restorePrivateSynchronization 内部要读改写 repo 状态（补 privateBindingId 与
  // privateRecipientId）。若允许并发进入，两路都会看到「尚无 binding」而各写一个 uuid，
  // 先写的那次被覆盖，已在旧 binding 上建立的 stream 订阅立即变成孤儿：不释放，还继续推事件。
  // [失败路径] 失败只上报投递结果并写 warn，不向上抛：调用方是入站消息主流程，
  // 订阅失败不能连带回滚已经完成的状态写入，也不能让整条消息被判为处理失败而重投。
  async function reconcilePrivateSynchronization(botId: string): Promise<void> {
    // [并发] 链在上一次的尾部而不是直接替换：Promise.resolve() 让首次调用也有可 await 的前驱，
    // 于是每个 botId 天然形成单链。换成 Set 记录「进行中」只能去重，无法保证先后顺序，
    // 后到的调用会与先到的并行读改写同一份状态。
    // 先 catch 掉前一次的失败，防止一次拒绝让后续对账永久短路：链一旦被拒绝，之后没人再触发恢复。
    const previous = privateReconciliations.get(botId) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => restorePrivateSynchronization(botId))
      .catch(async (error: unknown) => {
        const bot = findBot(await repo.readConfig(), botId);
        if (bot) onDeliveryResult(bot, error instanceof Error ? error.message : String(error));
        botsLogger.warn(undefined, `Private Bot subscription failed bot=${botId}`);
      });
    // 先登记再 await：登记窗口必须覆盖整个执行期。若在 await 之后才登记，
    // 期间到达的第二次调用读不到前驱，会与本次并行执行。
    privateReconciliations.set(botId, pending);
    try {
      await pending;
    } finally {
      // 只清理仍是自己的登记项：若已被后来者替换，说明已有新链在排队，
      // 此时 delete 会抹掉后来者的串行锁位，让第三次调用与前驱并发。
      if (privateReconciliations.get(botId) === pending) privateReconciliations.delete(botId);
    }
  }

  // 从持久状态重建单个 bot 的单聊订阅。顺序固定：判定有效性 → 补 binding → 比较签名 →
  // 二次确认连接 → 冷恢复快照 → 建流 → 登记。副作用包括写 repo、释放旧订阅、远端取快照、注册流；
  // 失败向调用方（reconcile 的 catch）冒泡，由那里统一转成用户可见的投递错误。
  // INV-02/INV-05：所有状态写入经 serializeStateWrite；远端未连接时既不建流也不发起任务请求。
  async function restorePrivateSynchronization(botId: string): Promise<void> {
    const bot = findBot(await repo.readConfig(), botId);
    let context = (await repo.readState()).bots[botId];
    // 微信的出站接收人是会话级的 privateRecipientId：扫码登录只返回 bot token/id，拿不到用户 id；
    // 其他 provider 的机器人身份与用户身份本就不同，直接用 providerUserId。
    // 两者错用会把回复投给机器人自己，或者投给一个平台不存在的会话。
    const recipient =
      bot?.provider === "weixin" ? context?.privateRecipientId : bot?.providerUserId;
    // 有效性是一次性算出的快照，后续所有判断都复用它，避免中途状态变化导致判定漂移。
    // [失败路径] 停服中（shutdownPromise）直接判无效：否则 disposeAll 之后仍会新建订阅并发请求，违反 INV-12。
    // 单聊订阅只在 task 态成立：draft 没有 activeTaskId 就没有事件源，建流只会空转并长期占用句柄。
    // INV-05：远端 workspace 未连接时判无效，避免对已断开的 host 建流并陷入失败重试。
    const valid =
      !shutdownPromise &&
      bot?.enabled &&
      recipient &&
      privateSyncSupported(bot) &&
      context &&
      !context.group &&
      context.mode === "task" &&
      context.activeTaskId &&
      isWorkspaceAllowed(
        context.workspaceId ?? getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
        bot.allowedWorkspaces,
      ) &&
      (await isRemoteWorkspaceConnected(context));
    if (valid && context && !context.privateBindingId) {
      // [并发] INV-02/INV-10：补 binding 必须在串行段内二次读取最新状态。外层读到的 context
      // 可能已被并发写入推进，按外层结果整份写回会把群状态、pending 交互改回旧值（内存覆盖磁盘）。
      // 二次检查 !latest.privateBindingId：两路对账同时到达时，只有先进入串行段的能生成 uuid。
      await serializeStateWrite(async () => {
        const state = await repo.readState();
        const latest = state.bots[botId];
        if (latest && !latest.privateBindingId) {
          state.bots[botId] = { ...latest, privateBindingId: randomUUID() };
          await repo.writeState(state);
        }
      });
      // 写后重读拿权威副本：binding 也可能被 capturePrivateContextToken 刚刚写入（微信切换接收人时
      // 会重置 binding），继续用旧 context 会把签名算成「无 binding」，导致订阅刚建好就被拆掉。
      context = (await repo.readState()).bots[botId];
    }
    // 签名只覆盖「决定订阅身份」的字段，刻意不含 updatedAt 等易变字段。
    // 若把时间戳算进去，每次状态写入都会让签名变化，订阅被反复拆建，每次都丢一段事件。
    // 无效时签名为空串，保证下面的 !== 判断一定成立，从而走统一的拆除路径。
    const signature = valid
      ? JSON.stringify([
          context?.privateBindingId,
          bot?.provider,
          recipient,
          context?.activeTaskId,
          context?.workspacePath,
          context?.workspaceIdentity,
        ])
      : "";
    const existing = privateWatches.get(botId);
    if (existing && existing.signature !== signature) {
      // [资源] 签名变化意味着 workspace/task/binding 任一变了，旧流的过滤条件已指向错误任务。
      // 必须先 dispose 再从 streamSubscriptions 摘除：只 delete 不 dispose 会让底层 watcher
      // 继续存活并持续推送，同一 bot 的多次切换会线性累积泄漏的流。
      streamSubscriptions.get(existing.key)?.dispose();
      streamSubscriptions.delete(existing.key);
      privateWatches.delete(botId);
      // 失败计数与 runtime 上的重试标记记的是旧任务的账，带到新任务会造成对错误投递的自动重试。
      failedPrivateDeliveries.delete(botId);
      const runtime = runtimeByBotId.get(botId);
      if (runtime)
        setRuntimeStatus({ ...runtime, deliveryRetryId: undefined, deliveryError: undefined });
    }
    // 四重短路，任一成立都不再建流：
    // (1) !valid：前置条件已不成立（停服/未连接/非 task 态），继续会违反 INV-05、INV-12；
    // (2) privateWatches.has(botId)：同签名已订阅，重复建流会让同一事件被投递两次；
    // (3) !signature：valid 为真时签名不可能为空，这里是类型收窄，避免把 undefined 拼进 key。
    if (!valid || !bot || !context || !signature || privateWatches.has(botId)) return;
    // 二次确认连接：上面补 binding 是一次写盘 await，期间可能已经断连；
    // 少了这次检查会向已断开的远端发起 listDeletedTaskIds/getTaskSnapshot。
    if (!(await isRemoteWorkspaceConnected(context))) return;
    const taskService = await resolveZCodeTaskServiceForContext(context);
    const deleted = await taskService.listDeletedTaskIds?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    // 已删除的任务不恢复订阅：否则用户删掉任务后，bot 仍会收到该任务的流事件并推送到单聊，
    // 表现为「删不掉的任务幽灵回复」。listDeletedTaskIds 是可选能力，缺失时按未删除处理。
    if (deleted?.includes(context.activeTaskId!)) return;
    // 只读取权威快照以冷恢复，不提交输入，也不回放快照中的历史正文。
    await taskService.getTaskSnapshot({
      taskId: context.activeTaskId!,
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      clientMode: "desktop-continuous",
    });
    // 快照是远端调用，await 期间 disposeAll 可能已经执行；此时建流会违反 INV-12。
    if (shutdownPromise) return;
    // actor 的 providerUserId 必须用 recipient 而不是 bot.providerUserId：微信场景下两者不同，
    // 用 bot 身份会让出站投递找不到会话；chatType 固定 private，群订阅不经过本函数。
    const actor: BotActor = {
      botId,
      provider: bot.provider,
      providerUserId: recipient!,
      chatType: "private",
    };
    const key = taskStreamKey(context, actor);
    // [并发] 先建流、后登记 privateWatches：反过来会出现「已登记但流尚未建立」的窗口，
    // 并发对账在此窗口内看到 has(botId) 直接返回，结果两条路径都跳过，永久没有订阅。
    await watchTaskStream(bot, actor, context, bot);
    privateWatches.set(botId, { signature, key });
  }

  // 微信上下文凭证的外部存储键：bot.id、机器人身份、credentialRef、接收人 id 四段哈希。
  // [权衡] 只落哈希不落明文：该键会进入日志与排障输出，明文拼接等于把用户标识与账号绑定关系外泄；
  // 纳入 credentialRef 是为了换凭证后旧 token 不会被新账号复用（否则会把 A 的上下文发给 B）。
  // [资源] 凭证本体存 credentialService，不写入 BotContextState，避免 bot 状态成为明文凭据的第二份副本。
  function weixinContextKey(bot: BotConfig, userId: string): string {
    // 凭证按账号和接收人隔离；不进入普通 Bot 状态或日志。
    return `bot-weixin-context-${createHash("sha256")
      .update(JSON.stringify([bot.id, bot.providerUserId, bot.credentialRef, userId]))
      .digest("hex")}`;
  }

  // 捕获微信私聊入站消息携带的 providerContextToken，把它转成可持续主动推送的会话凭据。
  // 只处理 weixin + private：群消息没有该 token 语义，其他 provider 的凭证由各自适配器管理。
  // [并发] INV-02：接收人变更与 binding 重置必须在同一次串行写入内完成。若分开两次写，
  // 中间态「新接收人 + 旧 binding」会让 restorePrivateSynchronization 认为订阅仍然有效，
  // 继续把事件推给旧会话，直到下一次状态变更才修复。
  // [资源] token 只交给 credentialService，不写入 bot 状态、不写日志：状态会被导出与排障读取。
  async function capturePrivateContextToken(message: BotInboundMessage): Promise<void> {
    if (message.actor.provider !== "weixin" || message.actor.chatType !== "private") return;
    // INV-01：bot 必须由该 actor 真正授权；bot.id !== message.botId 的检查防的是
    // 入站消息谎报 botId——否则会把上下文写到另一个 bot 的状态里，后续投递全部错位。
    const bot = findAuthorizedBot(await repo.readConfig(), message.actor);
    if (!bot || bot.id !== message.botId) return;
    // 没有授权上下文说明该 bot 尚未绑定工作区，此时写接收人只会留下无法投递的悬空状态。
    const context = await readContext(message.actor, bot);
    if (!context) return;
    // iLink 的 config.providerUserId 是机器人身份，不能把它当成出站接收人。
    await serializeStateWrite(async () => {
      const state = await repo.readState();
      const latest = state.bots[bot.id];
      if (!latest) return;
      // 只在接收人真正变化时写盘：否则每条消息都会产生一次状态版本与一次 binding 重置，
      // binding 一变签名就变，订阅被反复拆建，每次都靠远端快照重新冷恢复。
      if (latest.privateRecipientId !== message.actor.providerUserId) {
        state.bots[bot.id] = {
          ...latest,
          privateRecipientId: message.actor.providerUserId,
          privateBindingId: randomUUID(),
        };
        await repo.writeState(state);
      }
    });
    // token 允许缺失：部分扫码或转发路径只带身份。缺失时保留刚写入的接收人，
    // 由下一条带 token 的消息补齐，不能因为缺 token 就回滚接收人或跳过订阅。
    if (message.actor.providerContextToken)
      await deps.credentialService.save(
        weixinContextKey(bot, message.actor.providerUserId),
        message.actor.providerContextToken,
      );
    // 状态与凭证都落地后才对账：反序会让 restore 先用旧 binding 建流，随后被本次写入的新
    // binding 判为签名变化而立刻拆除，白跑一次远端快照并丢掉这段时间的事件。
    await reconcilePrivateSynchronization(bot.id);
  }

  // 拆除群任务的事件订阅。键由 workspace + taskId + 群状态键组成，与私聊键（taskStreamKey）
  // 刻意分开：同一 task 可能同时被单聊 owner 与群同时订阅，两类订阅必须能独立存活与拆除。
  // [资源] 先 dispose 再 delete：只删表项会让 watcher 继续运行并向已关闭的群投递，
  // 表现为「群已停用但仍在刷进度」。这里不动 privateWatches，因为那是另一套订阅身份。
  function stopGroupSynchronization(context: BotContextState): void {
    if (!context.group || !context.activeTaskId) return;
    const key = [
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      context.activeTaskId,
      getBotStateKey(context),
    ].join("::");
    streamSubscriptions.get(key)?.dispose();
    streamSubscriptions.delete(key);
  }

  // 从持久状态重建某个群任务的订阅（进程重启、或 re-enable 后调用）。
  // 只订阅后续事件：不重放历史输入、不补发已完成的 terminal 结果，避免重复回复（INV-07 同类约束）。
  // INV-01：群订阅的授权锚点是 group.ownerId 必须等于 bot.providerUserId，owner 变了就不再建流，
  // 否则新 owner 会继承上一任的事件流与操作能力。INV-05：远端未连接时不建连接。
  async function restoreGroupSynchronization(context: BotContextState): Promise<void> {
    // 三重前置：群开关、进行中的任务、未停服。缺 activeTaskId 时没有事件源，
    // 建流只会得到一个永远不产出的订阅，还占用平台的推送配额。
    if (!context.group?.enabled || !context.activeTaskId || shutdownPromise) return;
    const bot = findBot(await repo.readConfig(), context.botId);
    if (
      !bot?.enabled ||
      !isFeishuBotProvider(bot.provider) ||
      bot.providerUserId !== context.group.ownerId
    )
      return;
    // 恢复仅订阅后续事件；远端断开时不建立新连接，也不重放已接收输入。
    if (!(await isRemoteWorkspaceConnected(context))) return;
    // replyMode 强制 summary_changes 并注入群级 currentOptions：群聊必须按总结粒度回复，
    // 且模型/模式要取群自己维护的选择，而不是 bot 的私聊选择，否则群里会按私聊配置跑任务。
    await watchTaskStream(
      bot,
      {
        botId: bot.id,
        provider: bot.provider,
        chatType: "group",
        chatId: context.group.chatId,
        threadId: context.group.threadId,
        rootMessageId: context.group.rootMessageId,
        providerUserId: context.group.ownerId,
      },
      context,
      { ...bot, currentOptions: context.group.currentOptions, replyMode: "summary_changes" },
    );
  }

  // 群启用/停用命令（/enable、/disable 一类）。只有 bot owner 能改，且只对飞书系 provider 生效。
  // 副作用：写群上下文状态、启停订阅、取消尚未消费的话题输入、可能发起 getGroupInfo 远端调用。
  // INV-01：授权判定只看 bot.providerUserId 与 group.ownerId，绝不看消息正文或 @ 文本；
  // 非 owner 的请求会附带 administratorReply，提示去找管理员而不是静默失败。
  async function handleGroupActivation(
    message: BotInboundMessage,
    enabled: boolean,
  ): Promise<BotOutboundMessage[]> {
    const locale = await readMessageLocale();
    const config = await repo.readConfig();
    const bot = findBot(config, message.botId);
    // 非群消息、群消息缺 chatId、bot 停用、非飞书系：统一回「仅支持私聊/不支持」。
    // 这里不回权限错误，是因为这些情况与操作者身份无关，提示找管理员只会误导。
    if (
      !bot?.enabled ||
      !isFeishuBotProvider(bot.provider) ||
      message.actor.chatType !== "group" ||
      !message.actor.chatId
    ) {
      return [createOutbound(message.actor, msg(locale, "privateChatOnly"))];
    }
    // INV-01：owner 判定用 provider 侧身份（消息来源已由适配器鉴权），不能用可伪造的显示名。
    // callbackToastOnly 让平台只弹 toast 不改卡片：拒绝提示不该覆盖用户眼前的原卡片内容。
    if (bot.providerUserId !== message.actor.providerUserId) {
      return [
        {
          ...administratorReply(
            message.actor,
            bot,
            "owner-command",
            createOutbound(message.actor, msg(locale, "groupOwnerOnly")),
          ),
          callbackToastOnly: true,
        },
      ];
    }
    // 群启用不等于平台授权；首次与再次启用都提供同一权限入口。
    const activationValues = {
      permissionsUrl:
        bot.provider === "lark" ? "https://open.larksuite.com/app" : "https://open.feishu.cn/app",
    };
    // 群上下文按「群」而不是按话题存：threadId/conversationThreadId 置空，
    // 保证同群不同话题共享同一份群状态与 owner 判定，避免每个话题各有一份 competing 配置。
    const key = getBotConversationKey({
      ...message.actor,
      threadId: undefined,
      conversationThreadId: undefined,
    });
    const existing = (await repo.readState()).bots[key];
    if (existing?.group?.ownerId === bot.providerUserId) {
      if (existing.group.enabled !== enabled) {
        // 状态切换前先停流：否则 disabled 之后仍会收到该任务的进度并投递到群里。
        stopGroupSynchronization(existing);
        // INV-02：这里基于读到的 existing 构造新对象整体写回，靠 writeContext 的串行保证原子性；
        // authorizationId 每次切换都轮换，使旧授权下发出的回调按钮在重放时失效（INV-11）。
        const updated = {
          ...existing,
          group: { ...existing.group, enabled, authorizationId: randomUUID() },
        };
        await writeContext(updated, true);
        // 停用后取消尚未被消费的话题输入：否则队列里的输入仍会在停用后触发任务。
        if (!enabled) await cancelGroupTopicInputs(message.actor);
        if (enabled) {
          // 重新启用时必须按 bot + chatId 重新扫描全部群上下文：一个 bot 可能在这个群里
          // 有多个任务态上下文，只恢复当前 key 会漏掉其他任务的订阅。
          for (const candidate of Object.values((await repo.readState()).bots)) {
            if (candidate.botId === bot.id && candidate.group?.chatId === message.actor.chatId)
              await restoreGroupSynchronization(candidate);
          }
        }
      }
      // 重复 enable/disable 也回同一条成功文案：命令必须幂等，用户重试或平台重投不该看到错误。
      return [
        createOutbound(
          message.actor,
          msg(locale, enabled ? "groupEnabled" : "groupDisabled", activationValues),
        ),
      ];
    }
    // 没有既有群上下文：只有 enable 才需要创建；disable 对未见过的群直接回「已关闭」。
    if (!enabled) return [createOutbound(message.actor, msg(locale, "groupDisabled"))];
    // 首次启用必须借用 owner 的私聊上下文来继承工作区：群本身没有工作区概念，
    // 缺了这层继承，新建的群任务不知道在哪个 workspace 里跑。
    // 用 chatType=private 且清空 chatId 去查，等价于「该用户在私聊里当前绑定的工作区」。
    const privateContext = await readContext(
      { ...message.actor, chatType: "private", chatId: undefined },
      bot,
    );
    if (!privateContext)
      return [
        administratorReply(
          message.actor,
          bot,
          "workspace",
          createOutbound(message.actor, msg(locale, "noWorkspaceAllowed")),
        ),
      ];
    // 草稿选项继承自私聊的当前任务（模型与思考等级），但 mode 强制 default：
    // 群聊不允许继承私聊的 yolo 之类交互豁免，否则有人在群里发起高权限操作。
    const inherited = await buildActiveTaskDraftOptions(privateContext);
    // getGroupInfo 是可选能力：失败或缺失时退回用 chatId 当群名，不能因此阻断启用流程。
    const info = await providers[bot.provider]?.getGroupInfo?.(bot, message.actor.chatId);
    const context: BotContextState = {
      botId: bot.id,
      workspacePath: privateContext.workspacePath,
      workspaceIdentity: privateContext.workspaceIdentity,
      workspaceId: privateContext.workspaceId,
      mode: "draft",
      activeTaskId: null,
      updatedAt: Date.now(),
      draftOptions: { ...inherited, mode: "default" },
      group: {
        chatId: message.actor.chatId,
        chatMode: info?.chatMode,
        name: info?.name ?? message.actor.chatId,
        ownerId: bot.providerUserId!,
        enabled: true,
        authorizationId: randomUUID(),
        taskIds: [],
        currentOptions: {
          // 模型重构后需继承完整选择，旧 model/thoughtLevel 字段已不再持久化。
          modelSelection: bot.currentOptions.modelSelection,
          mode: "default",
        },
      },
    };
    // INV-02 的实际落点：群上下文必须经 writeContext 串行写盘，否则并发 enable 会各写一份
    // 不同 authorizationId 的群状态，后写覆盖先写，先写那一路刚建的订阅随即失去授权锚点。
    await writeContext(context, true);
    return [createOutbound(message.actor, msg(locale, "groupEnabled", activationValues))];
  }

  // 话题历史读取开关（群内命令）。enabled 为 undefined 表示「只查询当前状态」。
  // 副作用：可能写群上下文、递增 groupHistoryEpoch（让进行中的历史补齐失效）、取消待消费的话题输入。
  // INV-01：授权来自 withAuthorizedContext 与 group.ownerId 双重校验，消息正文不参与判定。
  async function handleGroupHistory(
    message: BotInboundMessage,
    enabled?: boolean,
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "workspace");
    if (!auth.ok) return auth.reply;
    // 历史读取的配置挂在群上下文上：私聊没有「讨论历史」这个概念，直接回操作提示而不是报错。
    if (!auth.context.group)
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US"
            ? "Topic history is configured in a group."
            : "请在群里配置话题历史读取。",
        ),
      ];
    // 与 handleGroupActivation 一致：群配置按群维度存，忽略 threadId，
    // 否则同一群不同话题会各存一份 historyEnabled，出现互相矛盾的开关。
    const key = getBotConversationKey({
      ...message.actor,
      threadId: undefined,
      conversationThreadId: undefined,
    });
    let active = false;
    // [并发] INV-02：状态读取、权限复核、写入必须在同一个串行段内完成。
    // 若在段外先读 parent 再进段写，期间 owner 可能已被转移，会以旧身份改写新 owner 的群配置。
    await serializeStateWrite(async () => {
      const state = await repo.readState();
      const parent = state.bots[key];
      // 授权在写入前复核一次，并抛错而不是返回 false：串行段无法向调用方返回业务失败，
      // 抛错会被上层统一转成可见错误，同时保证不落盘（INV-01）。
      if (!parent?.group?.enabled || parent.group.ownerId !== message.actor.providerUserId)
        throw new Error("Group authorization changed");
      if (enabled !== undefined) {
        parent.group.historyEnabled = enabled;
        await repo.writeState(state);
      }
      // 每次显式切换都推进 epoch：进行中的话题输入据此丢弃自己那一次历史补齐结果，
      // 否则关闭后仍会把在途的历史消息补进任务（开关语义被打穿）。
      // 注意 epoch 键用 message.botId 而非 parent.botId，两者在本路径上相同，但前者是入站事实。
      if (enabled !== undefined) {
        const key = JSON.stringify([message.botId, parent.group.chatId]);
        groupHistoryEpoch.set(key, (groupHistoryEpoch.get(key) ?? 0) + 1);
      }
      // active 取「未见过的群默认开启」：历史字段缺省时按开启处理，与旧状态兼容。
      active = parent.group.historyEnabled !== false;
    });
    // 只在关闭时取消待消费输入：开启不该打断队列，否则用户刚打开开关就看到自己的输入被清空。
    if (enabled === false) await cancelGroupTopicInputs(message.actor);
    return [
      createOutbound(
        message.actor,
        auth.locale === "en-US"
          ? active
            ? "Topic history enabled. The next topic input reconciles discussion history."
            : "Topic history is off. Topic input is paused."
          : active
            ? "已开启话题历史读取。下次话题输入会补齐讨论历史。"
            : "话题历史读取已关闭，话题输入已暂停。",
      ),
    ];
  }

  // 进入「新任务草稿」的统一收口。所有需要清空当前任务的入口（/new、/workspace 切换等）都走这里，
  // 保证三件事同时发生：清 activeTaskId、清 pending 交互、清该上下文的待选菜单。
  // 返回值是新上下文副本，调用方后续操作应基于它而不是旧 context，否则会把旧 taskId 写回去。
  // INV-04：pendingPermissionOptions/pendingElicitation 必须与草稿态一起清空，不能留下悬挂交互。
  async function writeDraftContext(
    context: BotContextState,
    draftOptions?: BotDraftOptions,
  ): Promise<BotContextState> {
    // Bugfix: 新建草稿状态以前散落在 /new 和 /workspace 分支里，各自手写 activeTaskId=null。
    // workspace 切换后如果还带着旧 task/pending permission，Telegram 权限按钮会命中错误上下文。
    // 这里把“进入新任务草稿”的服务端状态变更收口到同一个 helper，避免跨 workspace 复用旧任务状态。
    const draftContext: BotContextState = {
      ...context,
      mode: "draft",
      activeTaskId: null,
      draftOptions,
      pendingPermissionOptions: undefined,
      pendingElicitation: undefined,
    };
    if (context.group) {
      // 群内只清「本群」的待选菜单：key 形如 botId::chatId::用户，用 botId 前缀 + 群段匹配，
      // 不能用 clearPrivatePendingSelectionsForBot，那会把同一 bot 其他群的菜单一并清掉。
      const prefix = `${context.botId}::`;
      for (const key of pendingSelectionsByContext.keys()) {
        if (key.startsWith(prefix) && key.includes(`::${context.group.chatId}::`)) {
          pendingSelectionsByContext.delete(key);
          pendingTaskSelectionsByContext.delete(key);
          pendingWorkspaceSelectionsByContext.delete(key);
        }
      }
    } else clearPrivatePendingSelectionsForBot(context.botId);
    // 先写状态再停流：反序时写盘失败会留下「订阅已停、上下文仍是 task」的组合，
    // 该任务从此既没有进度也没有可见错误，只能靠用户重新发消息触发对账。
    await writeContext(draftContext);
    stopGroupSynchronization(context);
    return draftContext;
  }

  // 微信首次激活的引导：扫码登录只拿到 bot 身份，拿不到可投递的用户 id，因此把「第一条入站消息」
  // 当作会话目标的建立时机，并且只回欢迎与帮助，不把这条文本当任务 prompt。
  // 返回 null 表示「不拦截」，调用方继续走正常消息处理。
  // INV-04：激活只写一次 weixinActivatedAt，重复首条消息不会重复回复。
  async function handleWeixinFirstActivation(
    message: BotInboundMessage,
    command: BotCommand,
  ): Promise<BotOutboundMessage[] | null> {
    // 只对微信的普通文本消息生效；命令有自己的处理路径，不能被激活文案抢占。
    if (message.actor.provider !== "weixin" || command.type !== "message") {
      return null;
    }
    const state = await repo.readState();
    const existing = state.bots[message.botId];
    // 五个字段任一非空都说明这个会话已经用过：激活只处理「全新、无任何进度」的会话。
    // 若只检查 weixinActivatedAt，旧状态（激活标记尚未引入时创建的会话）会被误判为新会话，
    // 从而把正在进行的任务草稿重置并插一条欢迎语。
    if (
      existing?.weixinActivatedAt ||
      existing?.draftOptions ||
      existing?.activeTaskId ||
      existing?.pendingPermissionOptions ||
      existing?.pendingElicitation
    ) {
      return null;
    }
    // 二次授权校验：上面的状态检查只是为了快速跳过，真正的权限仍由 withAuthorizedContext 给出。
    const auth = await withAuthorizedContext(message, "help");
    if (!auth.ok) {
      return auth.reply;
    }
    // 状态与授权上下文是两次独立读取，中间可能已被并发激活写入，必须再查一次。
    if (auth.context.weixinActivatedAt) {
      return null;
    }
    // Bugfix: 微信扫码登录只返回 bot token/id，不返回可投递的用户 id。
    // 第一条微信入站消息用于建立会话目标，因此只回激活说明，不把“你好”这类激活文本误当成任务 prompt。
    await writeContext({
      ...auth.context,
      weixinActivatedAt: Date.now(),
    });
    return [
      createOutbound(
        message.actor,
        [msg(auth.locale, "weixinActivatedWelcome"), buildHelpText(auth.locale, auth.bot)].join(
          "\n\n",
        ),
      ),
    ];
  }

  // 群内「需要管理员介入」的统一提示器：按 (actor, reason) 去重，避免同一问题每次失败都 @ 同一批人。
  // 生命周期与 service 实例绑定（模块级单例），dispose 时由上层统一清理内部计时状态。
  const adminAttention = createGroupAdminAttention();

  // 给回复补上管理员 @ 信息。仅群聊生效：私聊没有「管理员」概念，@ 只会污染消息体。
  // administratorAttention 反映「本次是否真的 @ 到了人」，供上层决定是否额外提示。
  function administratorReply(
    actor: BotActor,
    bot: Pick<BotConfig, "providerUserId">,
    reason: string,
    reply: BotOutboundMessage,
  ): BotOutboundMessage {
    if (actor.chatType !== "group") return reply;
    const mentionedUserIds = adminAttention.mention(actor, bot.providerUserId, reason);
    return { ...reply, mentionedUserIds, administratorAttention: !!mentionedUserIds?.length };
  }

  // 把 BotAdminRequiredError 转成「带管理员 @ 与操作建议」的可见回复；其他错误原样返回。
  // 只处理 BotAdminRequiredError：这是本文件自己定义的可操作错误类型，其余异常属于程序缺陷，
  // 不该伪装成管理员配置问题。
  function administratorErrorReply(
    actor: BotActor,
    bot: BotConfig | null | undefined,
    error: unknown,
    reply: BotOutboundMessage,
  ): BotOutboundMessage {
    if (!bot || actor.chatType !== "group" || !(error instanceof BotAdminRequiredError))
      return reply;
    // model 类的错误对用户完全不可操作，补一句「请联系管理员检查模型配置」；
    // 其余 reason（remote/workspace 等）本身已在正文里给出下一步动作，重复提示只会稀释信息。
    const hint =
      error.reason === "model"
        ? cachedLocale === "en-US"
          ? "Please check this conversation's model configuration."
          : "请机器人管理员检查当前会话的模型配置。"
        : undefined;
    return administratorReply(
      actor,
      bot,
      error.reason,
      hint ? { ...reply, text: `${reply.text}\n\n${hint}` } : reply,
    );
  }

  // 读取并缓存界面语言。settings 服务是可选依赖，且它自身的失败不能用空值覆盖已知语言：
  // 因此 catch 返回 null，再用 ?? 保留 cachedLocale。若直接赋值，一次设置读取抖动会让
  // 已经确定为 en-US 的用户在后续回复里突然收到中文。
  async function readMessageLocale(): Promise<Locale | undefined> {
    const settings = await deps.settingService?.get().catch(() => null);
    cachedLocale = settings?.locale ?? cachedLocale;
    return cachedLocale;
  }

  // 文案取用的唯一入口。统一走 formatBotMessage 而不是在这里拼接，
  // 保证占位符替换与缺失文案回退只有一处实现，避免某个分支漏传 values 导致文案里露出 {x}。
  function msg(
    locale: Locale | undefined,
    id: BotMessageId,
    values?: Record<string, string | number | undefined>,
  ): string {
    return formatBotMessage(locale, id, values);
  }

  // 识别「会话已失效」类协议错误。用正则而不是错误码：这类错误来自 CLI 的文本协议，
  // 上游没有稳定的 code 字段，只能匹配消息前缀；因此匹配范围刻意收窄到 Session 开头的两种固定说法，
  // 避免把用户正文里出现的同名字样误判成会话失效。
  function isSessionExpiredError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /\bSession (not found|is not active):/i.test(message);
  }

  // 把内部错误转成用户可读文本。只对「会话失效」做特殊处理，其余错误保留原文：
  // 其余错误多为配置/远端问题，原文里带有用户可行动的路径或提示，改写反而丢信息。
  // [失败路径] 会话失效的原文（含 session id）对用户不可操作，还会泄露内部标识，故替换成「新建任务」引导。
  function formatUserFacingBotError(error: unknown, locale: Locale | undefined): string {
    // Bugfix: 旧 bot 消息或脏 task index 会让协议层抛出 Session not found。
    // 直接把 session id 发给用户不可操作；这里保留日志原文，只引导用户新建任务恢复。
    if (isSessionExpiredError(error)) {
      return msg(locale, "sessionExpiredNewTaskHint");
    }
    return error instanceof Error ? error.message : String(error);
  }

  // 附件文件名净化。文件名来自外部消息，会参与本地缓存路径拼接，因此必须在这里阻断路径逃逸。
  // [资源] 三类处理缺一不可：
  // (1) 控制字符（<32）会产生截断或终端转义；
  // (2) 路径分隔符与 Windows 保留字符会让 writeFile 落到目录之外或直接失败；
  // (3) 截断到 160 字符，避免超长名触发文件系统 ENAMETOOLONG（该错误发生在下载之后，白耗一次带宽）。
  // 用 Array.from 而不是 slice 是为了按码点处理，中文/emoji 文件名不会被切成半个代理对。
  function sanitizeAttachmentFilename(filename: string): string {
    const normalized = Array.from(filename.trim())
      .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? "_" : char))
      .join("");
    // 全部字符被替换成下划线时仍可能非空，只有真正空串才回退到固定名，保证路径段永不为空。
    return normalized.length > 0 ? normalized.slice(0, 160) : "attachment";
  }

  // 面向用户的附件体积文案。未知体积单独成词而不是显示 0B：
  // 0B 会让用户以为文件是空的，而实际只是 provider 没给 sizeBytes。
  function formatAttachmentSize(sizeBytes: number | undefined): string {
    if (!sizeBytes || sizeBytes <= 0) {
      return "unknown size";
    }
    // 阈值与展示精度绑定：MB 保留一位小数足够表达量级，KB 向上取整避免出现 0KB。
    if (sizeBytes >= 1024 * 1024) {
      return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
    }
    if (sizeBytes >= 1024) {
      return `${Math.ceil(sizeBytes / 1024)}KB`;
    }
    return `${sizeBytes}B`;
  }

  // 把附件准备阶段的异常翻译成用户可见原因。INV-06：超限必须走可见错误，不能静默截断或丢弃。
  // [权衡] 这里靠匹配 message 文本来分类，是因为上游 provider 适配器抛的是普通 Error，
  // 没有错误码；代价是文案一旦改动分类就会失效，因此匹配串必须与适配器里的抛出文本保持同步。
  function formatAttachmentRejectedReason(error: unknown, locale: Locale | undefined): string {
    const message = error instanceof Error ? error.message : String(error);
    // 体积超限是用户可自行解决的情况，给出「附件过大」并保留具体上限语义（5MB 由常量统一）。
    if (/exceeds 5MB/i.test(message)) {
      return msg(locale, "attachmentTooLarge");
    }
    // 下载类失败统一折叠成「暂时不可用」：链接过期、平台限频、网络超时对用户是同一类不可行动状态，
    // 区分它们只会暴露内部 URL 与 HTTP 状态码。
    if (
      /attachment download failed/i.test(message) ||
      /file download failed/i.test(message) ||
      /download .+ failed: HTTP/i.test(message) ||
      /file download timed out/i.test(message) ||
      /attachment download timed out/i.test(message) ||
      /download .+ timed out/i.test(message)
    ) {
      // Bugfix: provider 下载错误会包含 Feishu/Telegram/HTTP 等内部细节，直接回给用户既不友好也不可行动。
      return msg(locale, "attachmentDownloadUnavailable");
    }
    // 未识别的错误保留原文：可能是权限或工作区问题，原文里含有用户需要看的路径。
    return message;
  }

  // 计算附件本地缓存路径。层级为 botId / 消息键 / 摘要-文件名，三层都经过净化。
  // [资源] 摘要取 sha256 前 16 位，输入包含 botId、消息键、附件 id：
  // 只用附件 id 会让不同消息里的同名附件互相覆盖；只用时间戳会让同一条消息重放时产生重复文件。
  function buildAttachmentCachePath(params: {
    botId: string;
    providerMessageId?: string;
    attachment: BotInboundAttachment;
  }): string {
    // 缺 providerMessageId 时退化为时间戳：此时无法稳定复用缓存，但至少不会让路径退化到同一层，
    // 因此下一次重放会得到新目录而不是覆盖正在被读取的文件。
    const messageKey = params.providerMessageId?.trim() || `message-${Date.now()}`;
    const digest = createHash("sha256")
      .update(`${params.botId}:${messageKey}:${params.attachment.id}`)
      .digest("hex")
      .slice(0, 16);
    return join(
      getAppConfigDir(),
      "bot-attachments",
      sanitizeAttachmentFilename(params.botId),
      sanitizeAttachmentFilename(messageKey),
      `${digest}-${sanitizeAttachmentFilename(params.attachment.filename)}`,
    );
  }

  // 直接按 downloadUrl 拉取附件字节。这是 provider 适配器没有实现 downloadAttachment 时的兜底路径。
  // 返回 null 表示「没有可用的下载地址」，由调用方决定是降级成文件名说明还是报错。
  // [资源] AbortController + 定时器必须成对释放：finally 里 clearTimeout，否则每次下载都留下一个
  // 到超时时间才触发的悬挂定时器，长会话里会持续累积（同时违反 INV-12 的「dispose 后不再有活动」）。
  async function fetchAttachmentDownloadUrl(
    attachment: BotInboundAttachment,
  ): Promise<Uint8Array | null> {
    if (!attachment.downloadUrl) {
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BOT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(attachment.downloadUrl, {
        signal: controller.signal,
      });
      // 非 2xx 必须抛错而不是返回 null：null 的语义是「没有地址」，会把 HTTP 失败误判成
      // 「该附件没有下载入口」，于是群聊里得到一个空附件而不是可见的下载失败。
      if (!response.ok) {
        throw new Error(`download ${attachment.filename} failed: HTTP ${response.status}`);
      }
      // 先整块读入内存再返回：下游要做 5MB 校验与 base64 编码，流式处理在这里没有收益。
      // [失败路径] 这里没有流式大小上限，超限只能靠调用方在拿到完整 buffer 后判断，
      // 因此超大文件会先被完整下载再被拒绝，属于已知的资源放大点。
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if ((error as { name?: unknown })?.name === "AbortError") {
        // Bugfix: 附件下载卡住时必须尽快失败并回复用户，不能让 bot 回调一直悬挂。
        throw new Error(`download ${attachment.filename} timed out.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // 按优先级解析附件字节：内联 base64（平台直传）→ 本地路径（已缓存/本地文件）→ provider 下载 → URL 兜底。
  // 顺序体现成本：前两者零网络，后两者才走网络，避免对已拿到的字节重复下载。
  // 返回 null 表示四条路都拿不到字节，调用方据此决定降级（私聊写文件名说明、群聊直接报错）。
  async function resolveAttachmentBytes(
    bot: BotConfig,
    attachment: BotInboundAttachment,
    actor: BotActor,
  ): Promise<{ attachment: BotInboundAttachment; data: Uint8Array } | null> {
    // 内联字节优先：它已经是消息的一部分，再走下载等于重复传输。
    if (attachment.dataBase64) {
      return {
        attachment,
        data: Buffer.from(attachment.dataBase64, "base64"),
      };
    }
    // 本地路径次之。注意这里直接 readFile，不做路径校验：该路径由本文件的 cacheResolvedAttachment
    // 生成或由适配器给出，属于内部可信输入；外部消息里的文件名不参与该分支的构造。
    if (attachment.localPath) {
      return {
        attachment,
        data: await readFile(attachment.localPath),
      };
    }
    const provider = providers[bot.provider];
    // provider 实现优先于 URL 兜底：适配器知道如何带鉴权头调用平台 API，
    // 直接 fetch downloadUrl 往往缺少 token 或签名，只能作为最后手段。
    const downloaded = await provider?.downloadAttachment?.(bot, attachment, actor);
    if (downloaded) {
      return downloaded;
    }
    const fromUrl = await fetchAttachmentDownloadUrl(attachment);
    return fromUrl ? { attachment, data: fromUrl } : null;
  }

  // 把已解析的字节落盘，并返回带 localPath 与真实 sizeBytes 的附件描述。
  // [资源] 先 mkdir -p 再写：目录层级由 botId/消息键组成，首次写入时并不存在。
  // written sizeBytes 用实际字节数而不是平台上报值：上报值可能是压缩前大小或干脆缺失，
  // 后续 5MB 校验与 prompt 文案都以真实字节为准（INV-06）。
  async function cacheResolvedAttachment(params: {
    bot: BotConfig;
    message: BotInboundMessage;
    attachment: BotInboundAttachment;
    data: Uint8Array;
  }): Promise<BotInboundAttachment> {
    const localPath = buildAttachmentCachePath({
      botId: params.bot.id,
      providerMessageId: params.message.actor.providerMessageId,
      attachment: params.attachment,
    });
    await mkdir(dirname(localPath), { recursive: true });
    // 整文件覆盖写：同一摘要路径意味着同一 bot、同一消息、同一附件，内容必然一致，
    // 覆盖是幂等的；用临时文件加 rename 在这里没有必要，因为读者只会在写完之后才拿到 localPath。
    await writeFile(localPath, params.data);
    return {
      ...params.attachment,
      localPath,
      sizeBytes: params.data.byteLength,
    };
  }

  // 把入站附件整理成「prompt 正文片段 + 结构化附件」两部分，供后续提交任务使用。
  // 输入：bot 配置、入站消息（含 text/attachments/actor）、locale（决定错误文案语言）。
  // 副作用：会把附件写入本地缓存目录；会发起 provider 下载或 HTTP 下载。
  // INV-06：数量与体积上限都在读取/落盘前校验，超限抛可见错误而不是静默截断。
  // [权衡] 同一份约束对群聊与私聊的处置不同：群聊超限/下载失败直接抛错（群内多人协作，
  // 悄悄丢附件会让所有人以为文件已提交）；私聊降级为正文里的「未能下载」说明（单人场景可补救）。
  async function prepareBotMessageContent(
    bot: BotConfig,
    message: BotInboundMessage,
    locale: Locale | undefined,
  ): Promise<PreparedBotMessageContent> {
    const isGroup = message.actor.chatType === "group";
    // 数量上限只在群聊里强制：群消息会占公共配额，且一次多附件会拖慢所有成员的事件循环。
    if (isGroup && (message.attachments?.length ?? 0) > BOT_MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(
        locale === "en-US"
          ? "Attach at most 4 files per message."
          : "每条消息最多提交 4 个附件，请拆分后发送。",
      );
    }
    // [权衡] 这里对所有会话都 slice，私聊的实际效果是「超出的附件被静默丢弃」，
    // 与上面的硬上限不同。保留 slice 是为了让群聊分支之外的旧调用方仍得到确定行为，
    // 代价是私聊超量时用户拿不到提示（已在风险清单中标注，未在本次注释任务中改动）。
    const rawAttachments = (message.attachments ?? []).slice(0, BOT_MAX_ATTACHMENTS_PER_MESSAGE);
    const zcodeAttachments: ZCodePromptAttachment[] = [];
    const fileLines: string[] = [];
    // 串行处理而不是 Promise.all：每个附件都要落盘并参与总量校验，
    // 并发下载会让「超限报错」发生在部分文件已缓存之后，留下无主缓存文件。
    for (const rawAttachment of rawAttachments) {
      const resolved = await resolveAttachmentBytes(bot, rawAttachment, message.actor);
      if (!resolved) {
        // 群聊无法降级：正文里写「未能下载」会让群成员误以为附件已随消息提交，
        // 而后续任务其实看不到内容，必须让本次输入显式失败。
        if (isGroup) throw new Error("attachment download failed");
        // 私聊降级：只描述文件名/类型/体积，任务仍可基于正文继续，用户也能自行重发文件。
        fileLines.push(
          `附件：${rawAttachment.filename} (${rawAttachment.mimeType}, ${formatAttachmentSize(rawAttachment.sizeBytes)})，未能下载。`,
        );
        continue;
      }
      // INV-06：体积校验必须在落盘之前。放到落盘之后会先把超大文件完整写入磁盘再拒绝，
      // 既浪费磁盘也留下一个永远不会被引用的缓存文件。
      // 注意这里校验的是真实字节数：平台上报的 sizeBytes 可能缺失或被压缩过。
      if (resolved.data.byteLength > BOT_MAX_ATTACHMENT_SIZE_BYTES) {
        throw new Error(`${resolved.attachment.filename} exceeds 5MB.`);
      }
      const cached = await cacheResolvedAttachment({
        bot,
        message,
        attachment: resolved.attachment,
        data: resolved.data,
      });
      // base64 只在这里算一次并复用：群聊分支与图片/音频分支都需要它，
      // 各自再转换一次会让同一份数据在内存里出现多份副本。
      const dataBase64 = Buffer.from(resolved.data).toString("base64");
      if (isGroup) {
        // 旧兼容入口只把文件路径拼进正文，既丢失 V4 附件又破坏末尾引用块；群输入只走标准寄存。
        // kind 只允许 image/audio/file 三值：其他类型统一降级为 file，避免下游按未知 kind 分支。
        zcodeAttachments.push({
          kind: cached.kind === "image" || cached.kind === "audio" ? cached.kind : "file",
          filename: cached.filename,
          mimeType: cached.mimeType,
          sizeBytes: resolved.data.byteLength,
          dataBase64,
          localPath: cached.localPath,
        });
        // 群聊不发正文说明行：群消息要尽量短，附件信息由结构化字段承载。
        continue;
      }
      if (cached.kind === "image" || cached.kind === "audio") {
        // 图片/音频既进结构化附件（模型能直接看/听），又在正文里写本地路径（工具链路能用）。
        // 二者同时存在是刻意的冗余，不是重复投递。
        zcodeAttachments.push({
          kind: cached.kind,
          filename: cached.filename,
          mimeType: cached.mimeType,
          dataBase64,
          // Bugfix：Bot 已把附件缓存到本地，ZCodePromptAttachment 也必须携带该路径。
          // 只在 prompt 文本里描述路径会让下游附件策略无法选择本地文件读取。
          localPath: cached.localPath,
        });
        // Bugfix: bot 附件已经被 gateway 下载并缓存到本地。只把图片作为 ZCode Agent image block 传入时，
        // 下游 agent 可能把内部临时 URL 再 curl 到 /tmp，导致重复下载、额外权限请求和模型安全拦截。
        // 因此同时把本地缓存路径写进 prompt，明确后续工具操作只能围绕本地文件进行。
        fileLines.push(
          `附件：${cached.filename} (${cached.mimeType}, ${formatAttachmentSize(cached.sizeBytes)})，已作为${cached.kind === "image" ? "图片" : "音频"}输入提供，并保存到：${cached.localPath}。如需读取附件，请直接使用这个本地路径，不要下载或访问临时/远程 URL。`,
        );
        continue;
      }
      // 普通文件无法进结构化附件（模型不直接消费），只能把本地路径交给工具链读取。
      fileLines.push(
        `附件：${cached.filename} (${cached.mimeType}, ${formatAttachmentSize(cached.sizeBytes)})，已保存到：${cached.localPath}`,
      );
    }
    // 正文为空但有附件时补一句占位 prompt：否则提交的 content 只有附件说明，
    // 下游可能把它当成「空输入」拒绝，用户看到的是「发送失败」而不是附件已收到。
    const trimmed = message.text.trim();
    const baseContent =
      trimmed || (rawAttachments.length > 0 ? msg(locale, "attachmentOnlyPrompt") : "");
    // 各段用空行分隔：附件说明行必须独立成段，避免与用户正文粘连后被当成同一句话的续写。
    return {
      content: [baseContent, ...fileLines].filter(Boolean).join("\n\n"),
      zcodeAttachments,
    };
  }

  // 判定某个已授权命令是否必须依赖远端 workspace runtime。
  // 白名单式排除：只有查询类与连接管理类命令可以在断连时执行；其余（发消息、改配置、响应交互）
  // 一旦落到本地 service 就会在错误的文件系统上创建任务（INV-05）。
  // [权衡] 只列举「断连也安全」的 BotAuthorizedCommand 白名单，而不是列举要拦的命令：新增命令默认被拦，
  // 否则它会在断连时悄悄落到本地文件系统，所以宁可多提示一次重连。
  function requiresRemoteWorkspaceRuntime(requestedCommand: BotAuthorizedCommand): boolean {
    return (
      requestedCommand !== "help" &&
      requestedCommand !== "status" &&
      requestedCommand !== "workspace" &&
      requestedCommand !== "reconnect" &&
      requestedCommand !== "reply"
    );
  }

  // 判断上下文所指向的 workspace 是否已连接。三种输入口径：
  // (1) 无 workspaceIdentity：本地工作区，恒为已连接；
  // (2) 有 identity 但没有重连服务：视为未连接；
  // (3) 有服务：委托 isConnected，查询本身失败也按未连接处理。
  // INV-05：这是所有「能否发起任务/输入/模型候选」判断的唯一入口，默认值必须偏向「不可用」。
  async function isRemoteWorkspaceConnected(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<boolean> {
    if (!context.workspaceIdentity) {
      return true;
    }
    if (!deps.remoteWorkspaceService) {
      // Bugfix: 远端 workspace 没有注入重连服务时，不能默认当作已连接。
      // 否则 Bot 会继续使用缓存模型创建 task，最终在远端 API 层才暴露“模型不存在”等误导性错误。
      return false;
    }
    // [失败路径] 查询异常折叠为 false：连接查询失败与断连对业务是同一后果（不能发请求），
    // 若向上抛，所有只读命令（/status、/help）都会因为一次探测失败而整体报错。
    return deps.remoteWorkspaceService
      .isConnected({
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
        ...(context.hostId ? { hostId: context.hostId } : {}),
      })
      .catch(() => false);
  }

  // 显式重连入口的底层实现（只有 /reconnect 命令会走到）。
  // 与 isRemoteWorkspaceConnected 的关系：本函数是唯一允许「主动建立连接」的路径，
  // 其他业务路径只允许查询状态，避免同一条普通消息有时执行、有时顺带把连接打开。
  async function reconnectRemoteWorkspaceForBot(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<BotRemoteWorkspaceReconnectResult> {
    // 本地 workspace 无需连接，直接成功：让 /reconnect 对本地项目也是幂等无害的。
    if (!context.workspaceIdentity) {
      return { ok: true };
    }
    // 没有注入服务时明确失败并给出原因，而不是回 ok：否则用户会以为已经重连，
    // 下一条消息仍然被 INV-05 拦截，形成「重连无效」的死循环观感。
    if (!deps.remoteWorkspaceService) {
      return {
        ok: false,
        message: "remote reconnect service unavailable",
      };
    }
    // hostId 仅在存在时透传：远端服务用它区分同名工作区的不同宿主。
    return deps.remoteWorkspaceService.ensureConnected({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      ...(context.hostId ? { hostId: context.hostId } : {}),
    });
  }

  // 按上下文选择 task service：本地上下文用注入的实例，远端上下文必须拿到远端 runtime 的实例。
  // INV-05：远端拿不到 runtime 时抛 BotAdminRequiredError（用户可见，带 /重连 引导），
  // 绝不回退到本地实例。
  // [失败路径] 抛错而非返回 null：所有调用方都假设「拿到 service 就能用」，
  // 返回 null 会让每一处都漏一次判空，且很容易在某处被当成「暂无数据」而静默通过。
  async function resolveZCodeTaskServiceForContext(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<IZCodeTaskService> {
    if (!context.workspaceIdentity) {
      return deps.zcodeTaskService;
    }
    const remoteZCodeTaskService = await deps.remoteWorkspaceService?.getZCodeTaskService?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      ...(context.hostId ? { hostId: context.hostId } : {}),
    });
    if (remoteZCodeTaskService) {
      return remoteZCodeTaskService;
    }
    // Bugfix: 远端 workspace 的 bot 请求不能缺 runtime 时静默走本地 zcodeTaskService。
    // 否则 /root 这类远端路径会在 macOS/Windows 本地 host 创建任务，模型和文件系统都错位。
    throw new BotAdminRequiredError(
      "remote",
      `当前远端项目 ${context.workspacePath} runtime 不可用，请发送 **/重连** 后重试。`,
    );
  }

  // 模型选择服务的同类选择逻辑，只暴露 getView（本文件只需要读视图，不需要改选择）。
  // 与 task service 的差别：这里不做本地回退的「半可用」处理，远端缺失同样直接抛错，
  // 因为模型候选一旦来自错误的 host，用户会在菜单里选到本地不存在或版本不同的模型（INV-08）。
  async function resolveModelSelectionServiceForContext(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<Pick<IModelSelectionService, "getView">> {
    if (!context.workspaceIdentity) return deps.modelSelectionService;
    const service = await deps.remoteWorkspaceService?.getModelSelectionService?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      ...(context.hostId ? { hostId: context.hostId } : {}),
    });
    if (service) return service;
    throw new BotAdminRequiredError(
      "remote",
      `当前远端项目 ${context.workspacePath} runtime 不可用，请发送 **/重连** 后重试。`,
    );
  }

  // 远端断连闸门：在真正执行命令前拦截所有需要 runtime 的请求。
  // 返回 null 表示放行；返回消息数组表示「已拦截并给出提示」，调用方直接回这条消息。
  // INV-05：判定顺序为「是否本地 → 是否必须远端 → 是否已连接」，两个前置条件都不满足时不查询连接状态，
  // 避免对每次 /help、/status 都发起一次远端探测。
  async function blockDisconnectedRemoteWorkspace(params: {
    message: BotInboundMessage;
    context: BotContextState;
    locale: Locale | undefined;
    requestedCommand: BotAuthorizedCommand;
  }): Promise<BotOutboundMessage[] | null> {
    if (
      !params.context.workspaceIdentity ||
      !requiresRemoteWorkspaceRuntime(params.requestedCommand)
    ) {
      return null;
    }
    if (await isRemoteWorkspaceConnected(params.context)) {
      // 连接已恢复就清掉管理员提醒的去重状态：否则下一次真正断连时，
      // 同一 reason 会被判定为「刚刚已提醒过」而不再 @ 管理员。
      adminAttention.clear(params.message.actor, params.context.group?.ownerId, "remote");
      return null;
    }
    // Bugfix: 普通消息、配置修改和权限响应不应该隐式改变远端连接状态。
    // 远端恢复只允许显式 /reconnect 触发，避免同一条消息有时执行、有时只是在后台打开连接。
    // [失败路径] 这里只提示不改状态：断连期间不写 pending 交互、不占投递幂等键，
    // 用户重连后重发同一条消息应当被当作全新输入处理（INV-03 的反面：不能提前占位）。
    return [
      administratorReply(
        params.message.actor,
        { providerUserId: params.context.group?.ownerId },
        "remote",
        createOutbound(
          params.message.actor,
          msg(params.locale, "remoteDisconnected", {
            workspacePath: params.context.workspacePath,
          }),
        ),
      ),
    ];
  }

  // 「当前」后缀的本地化。英文用 current 而不是 selected：后者在选项列表里容易被读成动作按钮。
  function currentOptionSuffix(locale: Locale | undefined): string {
    return locale === "en-US" ? "current" : "当前";
  }

  // 把回复粒度 id 转成用户可读标签。两步归一化不能省：
  // 先按 provider 归一（不同 provider 支持的粒度集合不同，旧值可能已不被支持），
  // 再按默认值兜底（缺省时展示当前生效的默认粒度，而不是空白）。
  // 找不到对应选项时回退到 id 本身：id 至少是可读的英文标识符，比空串更利于排查。
  function formatReplyGranularityLabel(
    id: BotReplyGranularity | undefined,
    locale: Locale | undefined,
    provider?: BotProvider,
  ): string {
    const currentId = provider
      ? normalizeBotReplyGranularity(provider, id)
      : (id ?? getDefaultBotReplyGranularity());
    return (
      getReplyGranularityOptions(locale, provider).find((option) => option.id === currentId)
        ?.label ?? currentId
    );
  }

  // 在选项文案上标出「当前选中项」。改的是 label 而不是加新选项：
  // 选项 id 必须与回调值一一对应（INV-11），插入额外条目会破坏 id 到行为的映射。
  // 注意这里返回新对象、不就地修改：selection 可能来自缓存，就地改会让下一次渲染叠加多个后缀。
  function markCurrentSelection(
    selection: SelectionPrompt,
    locale: Locale | undefined,
  ): SelectionPrompt {
    const cancelLabel = msg(locale, "selectionCancelOption");
    if (!selection.currentId) {
      return { ...selection, cancelLabel };
    }
    const suffix = currentOptionSuffix(locale);
    return {
      ...selection,
      cancelLabel,
      options: selection.options.map((option) =>
        option.id === selection.currentId
          ? { ...option, label: `${option.label} · ${suffix}` }
          : option,
      ),
    };
  }

  // 兼容保留的空实现：用户侧配置项目前只由任务级 configOptions 提供，
  // 这里返回空数组是契约的一部分（调用方据此认为「没有额外用户配置」），不要改成抛错。
  async function listUserConfigOptions(
    _params: BotUserConfigOptionsParams,
  ): Promise<ZCodeConfigOption[]> {
    return [];
  }
  // 等待 Bot 存储初始化完成（配置 + 状态各读一次），并把结果缓存在模块级 Promise 上。
  // [并发] 失败时把缓存置回 null：若保留 rejected promise，之后每次调用都会立刻失败，
  // 即使底层磁盘问题已经恢复也无法自愈。置 null 让下一次调用重新尝试。
  async function ensureBotStorageMigrated(): Promise<void> {
    // 单向导入已收口到 Repo；这里只等待初始化，不再读取旧模型字段或重写当前状态。
    if (!botStorageMigrationPromise) {
      botStorageMigrationPromise = Promise.all([repo.readConfig(), repo.readState()])
        .then(() => undefined)
        .catch((error: unknown) => {
          botStorageMigrationPromise = null;
          throw error;
        });
    }
    await botStorageMigrationPromise;
  }

  // 读取「某个已存在任务」的配置项（含 model/mode/thoughtLevel 的当前值与可选值）。
  // 必须走 resolveZCodeTaskServiceForContext：远端任务只能由远端 runtime 解释，
  // 本地实例读同一 taskId 会得到不存在或陈旧的数据（INV-05）。
  async function listActiveTaskConfigOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
  ): Promise<ZCodeConfigOption[]> {
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    return zcodeTaskService.getTaskConfigOptions({ taskId });
  }

  // 在配置项里查找某个 select 类型的项。两段匹配是必要的兼容层：
  // 新配置用 category（thought_level），旧配置只写了 id（thoughtLevel），
  // 只按其中一种匹配会在升级边界上让用户看到「当前模式缺失」。
  // [权衡] 用 type guard 收窄而不是断言：调用方紧接着读 .options/.currentValue，
  // 若上层传入同名但非 select 的项，断言会在这里静默产生 undefined 字段。
  function findSelectConfigOption(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
  ): (ZCodeConfigOption & { type: "select" }) | undefined {
    const category = configId === "thoughtLevel" ? "thought_level" : configId;
    return options.find(
      (item): item is ZCodeConfigOption & { type: "select" } =>
        item.type === "select" && (item.category === category || item.id === category),
    );
  }

  // 把配置项的候选项投影成 Bot 菜单项。id 直接用 item.value：
  // 这个值之后会被原样回传给 setXxx 接口，中间不能做任何归一化，否则会写回一个不存在的选项。
  // label 统一过 formatConfigOptionLabel，保证菜单与工具栏的展示一致（见下方 mode 特化）。
  function listConfigSelectOptions(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): BotModelOption[] {
    const option = findSelectConfigOption(options, configId);
    // 配置项缺失时返回空数组而不是抛错：菜单为空是合法状态（该 provider 不支持此配置），
    // 上层用「是否为空」决定是否展示该命令，抛错会让整个 /config 不可用。
    return (option?.options ?? []).map((item) => {
      const baseOption = {
        id: item.value,
        label: item.name,
        description: item.description,
      };
      return {
        ...baseOption,
        // 保持 Bot 与工具栏的模式展示一致。
        label: formatConfigOptionLabel(baseOption, {
          configId,
          locale: context.locale,
          provider: context.provider,
        }),
      };
    });
  }

  // 配置项整体缺失时的提示文案 id。只覆盖 mode/thoughtLevel：
  // model 缺失会走另一条「检查模型配置」的管理员错误路径，两者错误语义不同。
  function getConfigCommandMissingMessageId(configId: "mode" | "thoughtLevel"): BotMessageId {
    return configId === "mode" ? "modeMissing" : "thoughtLevelMissing";
  }

  // mode 的展示名特化表。只有 glm 需要覆盖：其上游返回的默认值文案在中文界面下是英文，
  // 直接用会把界面语言混在一起。未列出的 provider 一律用上游 label，避免维护一张会过期的全量表。
  function getModeDisplayLabel(
    locale: Locale | undefined,
    provider: ZCodeProvider | undefined,
    option: Pick<BotModelOption, "id" | "label">,
  ): string {
    if (!provider) {
      return option.label;
    }
    const isEnglish = locale === "en-US";
    const labels: Partial<Record<ZCodeProvider, Record<string, string>>> = {
      glm: {
        default: isEnglish ? "Default" : "默认",
        yolo: "Yolo",
        plan: isEnglish ? "Plan" : "计划",
      },
    };
    return labels[provider]?.[option.id] ?? option.label;
  }

  // 展示名分派：只有 mode 需要特化，model/thoughtLevel 的 label 已经由上游给出可用文案。
  // 保留这个单点分派而不是在三个调用处各写一遍 if，是为了让「哪些配置需要本地化」只有一处答案。
  function formatConfigOptionLabel(
    option: BotModelOption,
    context: {
      configId: "model" | "mode" | "thoughtLevel";
      locale?: Locale;
      provider?: ZCodeProvider;
    },
  ): string {
    if (context.configId !== "mode") {
      return option.label;
    }
    return getModeDisplayLabel(context.locale, context.provider, option);
  }

  // 把模型选择视图里的 provider 投影成 Bot 菜单：id 用 providerId，label 用可读名（缺失时回退 id）。
  // INV-08：每个 model 的 id 都必须是 encodeCustomModelValue(providerId, modelId) 编码后的可逆值，
  // 不能只用 modelId。原因：不同 provider 的 modelId 会重名（例如都叫 default），
  // 只存 modelId 时就无法还原 provider，回退逻辑会把用户选择改写成别的 provider 的模型。
  function createModelSelectionProviderOption(
    provider: ModelSelectionView["providers"][number],
  ): BotModelProviderOption {
    return {
      id: provider.providerId,
      label: provider.providerName?.trim() || provider.providerId,
      models: provider.models.map((model) => ({
        id: encodeCustomModelValue(provider.providerId, model.modelId),
        label: model.modelId,
      })),
    };
  }

  // 读取模型选择视图（provider 列表 + 每个 provider 的模型 + 生效选择）。
  // 三重容错：服务解析失败、getView 调用失败都折叠成 null，交给调用方决定是「空菜单」还是「回退」。
  // 不能向上抛：菜单渲染失败不该让整条命令失败，/status 之类只读路径也会调用它。
  // [失败路径] 用 .call(service, ...) 而不是 service.getView(...)：getView 可能依赖 this 上注入的上下文。
  async function readModelSelectionView(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    selection?: ModelSelection,
  ): Promise<ModelSelectionView | null> {
    const service = await resolveModelSelectionServiceForContext(context).catch(() => null);
    if (!service) return null;
    return service.getView
      .call(service, selection ? { selection } : undefined)
      .catch((error: unknown) => {
        // 只 warn 不上报投递错误：这是展示链路，失败的表现是菜单为空，用户重试即可恢复。
        botsLogger.warn(
          undefined,
          `read model selection view for bot model display failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
  }

  // 列出所有「至少有一个模型」的 provider 选项。
  // [权衡] 不做本地补选：远端断连时宁可空菜单，也不能用本地写死列表补，
  // 否则用户会选中一个当前 host 上不存在的模型，直到任务创建时才失败（INV-08 的可逆性前提被破坏）。
  async function listModelSelectionProviderOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<BotModelProviderOption[]> {
    const view = await readModelSelectionView(context);
    // 旧缓存没有 workspaceIdentity 隔离，远端断连时会显示其他 Host 的候选。
    // 当前菜单只消费目标 View；失败留空，下一次正常读取即可恢复，不借本地补选。
    if (!view) return [];
    // 过滤掉零模型的 provider：菜单里出现一个点进去是空的条目，比不显示更困惑用户。
    return view.providers
      .map(createModelSelectionProviderOption)
      .filter((provider) => provider.models.length > 0);
  }

  // 任务维度的 provider 列表。_activeProvider 刻意保留但未使用：
  // 现在候选完全来自工作区视图，不再按 provider 过滤；保留参数是为了不改动上层调用签名。
  async function listModelProviderOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    _activeProvider: ZCodeProvider,
  ): Promise<BotModelProviderOption[]> {
    return listModelSelectionProviderOptions(task);
  }

  // 取某个 provider 下的模型列表。找不到 provider 时返回空数组而不是抛错：
  // 该 provider 可能在新版本里被移除，此时菜单应为空并让上层提示重新选择，而不是整条命令失败。
  async function listModelOptionsForProviderFromActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
    providerId: string,
  ): Promise<BotModelOption[]> {
    return (
      (await listModelProviderOptionsForActiveTask(task, activeProvider)).find(
        (provider) => provider.id === providerId,
      )?.models ?? []
    );
  }

  // 从持久化的 provider 快照里读出模型列表。入参是 unknown：该值来自磁盘状态，
  // 可能是旧版本结构或被手工改坏的数据，因此逐字段校验而不是直接断言。
  // 任何一部分不合法就跳过（filter），保留其余合法项——部分可用胜过整份丢弃。
  function readModelProviderSelectionModels(provider: unknown): BotModelOption[] {
    const models = isRecord(provider) ? provider.models : undefined;
    if (!Array.isArray(models)) {
      return [];
    }
    return models.filter(
      (model): model is BotModelOption =>
        isRecord(model) && typeof model.id === "string" && typeof model.label === "string",
    );
  }

  // 展平所有 provider 的模型。用于「按模型名反查 provider」一类场景：
  // 此时用户只给了模型值，需要遍历全部候选才能确定它属于哪个 provider。
  async function listAllModelOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
  ): Promise<BotModelOption[]> {
    return (await listModelProviderOptionsForActiveTask(task, activeProvider)).flatMap(
      (provider) => provider.models,
    );
  }

  // 读取当前生效的模型值。口径优先级：配置项的 currentValue 高于任务元数据里的 model。
  // 原因：任务创建后用户仍可能通过 /model 改选择，配置视图才是最新事实；
  // task.model 是创建时的快照，只在拿不到配置项时兜底。
  function readCurrentActiveTaskModel(
    task: Pick<ZCodeTaskMeta, "model">,
    options: readonly ZCodeConfigOption[],
  ): string | undefined {
    return readConfigSelectCurrentValue(options, "model") ?? task.model;
  }

  // 把模型值格式化成 /status 里展示的「供应商/模型」文案。两种历史格式都要认：
  // (1) 编码过的自定义模型值（decodeCustomModelValue 可解出 providerId）；
  // (2) 旧格式 providerId/modelId 的裸拼接。
  // 两者都不能直接展示：providerId 对用户没有意义，需要换成 providerLabel（INV-08 的展示侧）。
  async function formatStatusModelLabel(
    model: string | undefined,
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<string> {
    if (!model) {
      return "-";
    }
    const customModel = decodeCustomModelValue(model);
    if (customModel?.providerId) {
      const modelSelectionOptions = await listModelSelectionProviderOptions(context);
      const providerLabel = modelSelectionOptions.find(
        (item) => item.id === customModel.providerId,
      )?.label;
      // modelName 缺失时只展示 provider 名：宁缺模型段，也不要显示编码后的原始值。
      if (providerLabel && customModel.modelName) {
        return `${providerLabel}/${customModel.modelName}`;
      }
      return providerLabel ?? model;
    }
    // 旧格式的切分必须校验两端非空：以 "/" 开头或结尾的值不是 provider/model 结构，
    // 按格式硬切会把模型名截断成看似合法的错误结果。
    const separatorIndex = model.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
      return model;
    }
    // 注意只按第一个 "/" 切分：模型名本身可能含斜杠（如组织/模型），必须保留在 modelName 里。
    const providerId = model.slice(0, separatorIndex);
    const modelName = model.slice(separatorIndex + 1);
    const modelSelectionOptions = await listModelSelectionProviderOptions(context);
    const providerLabel = modelSelectionOptions.find((item) => item.id === providerId)?.label;
    // Bugfix: /status 只应该暴露用户能识别的模型供应商名称。
    // 旧 bot-state 或 task config 可能保存成 providerId/modelId，providerId 对用户没有意义。
    return providerLabel ? `${providerLabel}/${modelName}` : model;
  }

  // 反查当前模型所属的 provider id，供菜单把用户落到正确的 provider 分组。
  // 三级回退：编码值直接解得 → 在候选里按模型 id 命中 → 使用 provider 的原生 id。
  // [权衡] 最后一级回退是刻意保守的：宁可把模型归到 native provider 下，也不要猜测另一个 provider，
  // 因为菜单里选错 provider 会导致下一次 /model 写入把模型换成不属于它的 provider（INV-08）。
  async function readCurrentModelProviderId(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    options: readonly ZCodeConfigOption[],
    activeProvider: ZCodeProvider,
  ): Promise<string | undefined> {
    const currentValue = readCurrentActiveTaskModel(task, options);
    if (!currentValue) {
      return undefined;
    }
    const customModel = decodeCustomModelValue(currentValue);
    if (customModel?.providerId) {
      return customModel.providerId;
    }
    return (
      (await listModelProviderOptionsForActiveTask(task, activeProvider)).find((provider) =>
        provider.models.some((model) => model.id === currentValue),
      )?.id ?? getNativeModelProviderId(activeProvider)
    );
  }

  // 把自定义模型值还原成 runtime 实际需要的 modelId。modelName 缺失时返回 undefined，
  // 让上层走「无法识别」分支（保留用户原始选择，不做静默改写，见 INV-08）。
  // _activeProvider 保留未用：历史上曾用它推断前缀，现在信息已完全包含在编码值里。
  function resolveCustomModelRuntimeModelId(
    _activeProvider: ZCodeProvider,
    customModel: { providerId: string; modelName?: string },
  ): string | undefined {
    if (!customModel.modelName) {
      return undefined;
    }
    return customModel.modelName;
  }

  // 读取配置项当前值，并收窄成 string。只接受字符串：
  // 旧状态里 currentValue 可能是对象（旧版 model 选择结构），此时应视为「没有当前值」，
  // 交给上层用任务元数据兜底，而不是把对象当模型值传给下游。
  function readConfigSelectCurrentValue(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
  ): string | undefined {
    const currentValue = findSelectConfigOption(options, configId)?.currentValue;
    return typeof currentValue === "string" ? currentValue : undefined;
  }

  // 校验某个 mode 在当前 provider 的配置项里是否仍然受支持，支持则原样返回，否则 undefined。
  // 存在意义：草稿里可能存着切换 provider 之前遗留的 mode（如 glm 的 plan），
  // 直接下发会在任务创建时被下游拒绝，因此这里提前过滤，让调用方回退到默认 mode。
  function resolveSupportedDraftMode(
    options: readonly ZCodeConfigOption[],
    mode: string | undefined,
    provider: ZCodeProvider,
  ): string | undefined {
    if (!mode) {
      return undefined;
    }
    return resolveProviderModeIdFromConfigOptions({
      configOptions: options,
      modeId: mode,
      provider,
    })
      ? mode
      : undefined;
  }

  // 读取配置项当前值的展示标签。找不到对应选项时回退到原始值本身：
  // 该值可能是旧版本写入的、当前 provider 已不提供的选项，展示原值至少能让用户看出「这里有个旧设置」，
  // 返回 undefined 则会让上层误以为「没有当前设置」。
  function readConfigSelectCurrentLabel(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): string | undefined {
    const currentValue = readConfigSelectCurrentValue(options, configId);
    if (!currentValue) {
      return undefined;
    }
    return (
      listConfigSelectOptions(options, configId, context).find(
        (option) => option.id === currentValue,
      )?.label ?? currentValue
    );
  }

  // 把任意候选值翻译成展示标签。与 readConfigSelectCurrentLabel 的差别是「值来自参数而不是配置项」：
  // 用于回调/历史记录里已经确定的选项，此时配置项可能已经不再包含它，因此同样在找不到时回退原值。
  function readConfigSelectLabelForValue(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    value: string | undefined,
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): string | undefined {
    if (!value) {
      return undefined;
    }
    return (
      listConfigSelectOptions(options, configId, context).find((option) => option.id === value)
        ?.label ?? value
    );
  }

  // 与 readCurrentActiveTaskModel 同构：配置项 currentValue 优先，任务元数据兜底。
  // 两条来源分开读取而不是合并成一个「当前配置」对象，是因为它们可能来自不同 host 的视图，
  // 合并会把远端任务元数据和本地配置项混成一份不可信的快照。
  function readCurrentActiveTaskMode(
    task: Pick<ZCodeTaskMeta, "mode">,
    options: readonly ZCodeConfigOption[],
  ): string | undefined {
    return readConfigSelectCurrentValue(options, "mode") ?? task.mode;
  }

  // provider 级配置项。当前实现恒为空（见 listUserConfigOptions），
  // 保留这层是因为调用方需要区分「provider 不支持任何用户配置」与「读取失败」两种空。
  async function listProviderConfigOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
  ): Promise<ZCodeConfigOption[]> {
    return listUserConfigOptions({
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
      provider: activeProvider,
    });
  }

  // 草稿选项的归一化。只改 provider 一个字段，其余字段原样保留：
  // 草稿里的 modelSelection/mode 是用户显式选择，不能因为 provider 归一而丢弃。
  // INV-08：归一化是单向收敛（旧三方 CLI → ZCode Agent），不回写用户看得见的选择值。
  function normalizeBotDraftOptions(draftOptions: BotDraftOptions): BotDraftOptions {
    // Bugfix: bot-state 里可能还残留旧三方 CLI 草稿 provider。
    // 如果直接复用，/new 后首条消息会重新创建第三方 runtime，绕过 ZCode Agent 单一事实源。
    return {
      ...draftOptions,
      provider: normalizeAgentProviderToZCodeAgent(draftOptions.provider),
    };
  }

  // 构造「尚未有任务」时的初始草稿选项。
  // INV-05：远端上下文未连接时只返回 provider，不写 mode：
  // mode 的可选值需要读远端配置，断连时写死一个值会在重连后被判定为不支持而回退，
  // 更糟的是会让用户误以为配置已生效。等重连成功后由 refreshed 流程补齐。
  async function buildInitializedDraftOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    provider?: ZCodeProvider,
  ): Promise<BotDraftOptions> {
    const requestedProvider = normalizeAgentProviderToZCodeAgent(
      provider ?? DEFAULT_BOT_ZCODE_PROVIDER,
    );
    if (context.workspaceIdentity && !(await isRemoteWorkspaceConnected(context))) {
      // Bugfix: 远端断连时初始化草稿也不能偷偷申请远端 ZCode Agent runtime。
      // 只有 /reconnect 能恢复连接；草稿先保留最小默认值，重连成功后再刷新。
      return { provider: requestedProvider };
    }
    // 群聊默认 default，私聊强制 BOT_FORCED_MODE（yolo）：群内多人协作必须保留权限确认，
    // 单聊是本人授权给 bot，可以免交互。这个区分只在这里与 applyDraftConfigOptions 两处定义。
    const resolvedProvider = requestedProvider;
    return {
      provider: resolvedProvider,
      mode: "group" in context && context.group ? "default" : BOT_FORCED_MODE,
    };
  }

  // 从「当前任务的真实配置」继承草稿选项（/new 时常用）。
  // 三条路径：(1) 无任务/无 provider → 已有草稿归一化，否则走初始草稿；
  // (2) 有任务 → 读该任务的 configOptions 与 modelSelection，保留 provider/模型/思考等级；
  // (3) mode 一律按「群 default / 私聊强制」重新求值，不继承原任务 mode。
  // INV-08：modelSelection 必须由任务服务读取领域选择，不能从菜单显示值反推。
  async function buildActiveTaskDraftOptions(context: BotContextState): Promise<BotDraftOptions> {
    const activeTask = await readContextActiveTaskMeta(context);
    if (!context.activeTaskId || !activeTask?.provider) {
      return context.draftOptions
        ? normalizeBotDraftOptions(context.draftOptions)
        : buildInitializedDraftOptions(context);
    }
    // 配置读取失败降级为空数组：继承是增强能力，读不到配置不该让 /new 整体失败；
    // 空的 configOptions 会让下面的 resolveSupportedDraftMode 返回 undefined，最终不下发 mode。
    const configOptions = await listActiveTaskConfigOptions(context, context.activeTaskId).catch(
      () => [],
    );
    const resolvedProvider = normalizeAgentProviderToZCodeAgent(activeTask.provider);
    // Bot 硬锁 yolo：继承当前 task 时也强制 yolo，不沿用原 task 的 mode。
    const forcedMode = resolveSupportedDraftMode(
      configOptions,
      "group" in context && context.group ? "default" : BOT_FORCED_MODE,
      resolvedProvider,
    );
    // 继承的是领域选择，不是菜单显示值；显示值中的 $max 曾被误存为 modelId。
    // 由同一工作区的任务服务读取真实选择，保留 Provider、模型和显式思考等级。
    const taskService = await resolveZCodeTaskServiceForContext(context);
    const modelSelection = await taskService.getTaskModelSelection({
      taskId: context.activeTaskId,
    });
    // 条件展开而不是写 undefined：undefined 字段会被 JSON 序列化成 null，
    // 后续「字段是否存在」的判断（例如是否沿用默认模型）就会被 null 骗过。
    return {
      provider: resolvedProvider,
      ...(modelSelection ? { modelSelection } : {}),
      ...(forcedMode ? { mode: forcedMode } : {}),
    };
  }

  // 确保上下文里有草稿选项，缺则构造并落盘。
  // [并发] INV-02：归一化后的 provider 与磁盘值不同才写回。无条件写回会让每次读草稿都产生一次
  // 状态写入，多路并发读会互相覆盖对方刚写的其他字段（整份 state 写回模型）。
  async function ensureDraftOptions(context: BotContextState): Promise<BotDraftOptions> {
    if (context.draftOptions) {
      const normalizedDraftOptions = normalizeBotDraftOptions(context.draftOptions);
      if (normalizedDraftOptions.provider !== context.draftOptions.provider) {
        await writeContext({ ...context, draftOptions: normalizedDraftOptions });
      }
      return normalizedDraftOptions;
    }
    const draftOptions = await buildInitializedDraftOptions(context);
    await writeContext({ ...context, draftOptions });
    return draftOptions;
  }

  // 写草稿选项并同步把上下文置为 draft/无任务。
  // 与 ensureDraftOptions 的区别：这里是「用户的显式改配置」路径，必须落到 draft 态；
  // 后者只是「确保有值」，不应改变已有任务状态。
  // 先归一化再落盘，避免把旧 provider 写回磁盘后又被下一次读取归一化，产生反复写。
  async function writeDraftOptions(
    context: BotContextState,
    draftOptions: BotDraftOptions,
  ): Promise<BotContextState> {
    const normalizedDraftOptions = normalizeBotDraftOptions(draftOptions);
    const nextContext: BotContextState = {
      ...context,
      mode: "draft",
      activeTaskId: null,
      draftOptions: normalizedDraftOptions,
    };
    await writeContext(nextContext);
    return nextContext;
  }

  // 供菜单展示用的草稿选项：把「存储的 modelSelection」换成「本次派发会真正使用的选择」。
  // 有显式选择时取 effectiveSelection（已按可用性收敛），没有时取 preferredSelection（工作区偏好）。
  // [权衡] 只返回副本、不写回：展示是只读动作，写回会让「打开菜单」产生状态变更，
  // 从而在用户什么都没点的情况下改变下一次任务的模型。
  async function resolveDraftOptionsForDisplay(context: BotContextState): Promise<BotDraftOptions> {
    const original = await ensureDraftOptions(context);
    const view = await readModelSelectionView(context, original.modelSelection);
    // 菜单也必须展示派发将使用的身份。这里只返回副本；查看菜单不能写回原草稿。
    return {
      ...original,
      modelSelection:
        (original.modelSelection ? view?.effectiveSelection : view?.preferredSelection) ??
        undefined,
    };
  }

  // 推导草稿态可用的配置项。当前只产出 thought_level 一项：
  // model/mode 的可选项由各自命令读取，这里只补 reasoningLevel，避免两处各算一遍导致漂移。
  // 依赖关系：selection 必须先有 providerId/modelId，才能从视图里找到模型并读出 reasoningLevel 规格。
  // 任何一环缺失都返回空数组而不是抛错——草稿配置是可选增强，缺失时用户仍能发消息。
  async function listDraftConfigOptions(
    context: BotContextState,
    draftOptions: BotDraftOptions,
    resolvedView?: ModelSelectionView | null,
  ): Promise<ZCodeConfigOption[]> {
    // undefined 与 null 语义不同：undefined 表示「没预取，你需要自己读」，
    // null 表示「调用方已读过且失败」。区分开是为了避免同一次渲染重复发起远端查询。
    const view =
      resolvedView === undefined
        ? await readModelSelectionView(context, draftOptions.modelSelection)
        : resolvedView;
    const selection = draftOptions.modelSelection
      ? view?.effectiveSelection
      : view?.preferredSelection;
    if (!selection) return [];
    // 用 providerId + modelId 双键查找：只看 modelId 会在不同 provider 有同名模型时匹配错模型，
    // 进而把 A 模型的 reasoningLevel 规格套到 B 模型上（与 INV-08 的编码动机同源）。
    const model = view?.providers
      .find((provider) => provider.providerId === selection.providerId)
      ?.models.find((candidate) => candidate.modelId === selection.modelId);
    const spec = model?.config.optionSpecs.reasoningLevel;
    // 模型未声明推理等级时返回空：伪造一个空 values 的 select 会让菜单出现无法选择的死选项。
    if (!spec) return [];
    return [
      {
        id: "thought_level",
        name: "Reasoning",
        category: "thought_level",
        type: "select",
        // 当前值缺失时用空串：下游据此展示「未设置」，而 undefined 会让部分菜单直接隐藏该项。
        currentValue: selection.options?.reasoningLevel ?? "",
        options: spec.values.map((value) => ({ value, name: value })),
      },
    ];
  }

  // 任务创建完成后，把草稿里的配置真正下发到任务。这是 mode 进入 agent session 的唯一咽喉。
  // 调用时机在 task 已创建、首条输入尚未发出之间；失败会向上传播，让本次输入显式失败，
  // 而不是让任务以错误权限模型继续运行。
  // [权衡] 每个 task 一发一条 setMode，而不是批量：setMode 是幂等的，按任务下发能保证
  // 与 task 生命周期严格对齐，避免「任务已建、配置没下发」的中间态被后续输入利用。
  async function applyDraftConfigOptions(
    context: BotContextState,
    taskId: string,
    traceId: string,
  ): Promise<void> {
    const draftOptions = context.draftOptions;
    // 没有草稿选项时什么都不下发：任务会使用服务端默认配置，
    // 这比用一份猜测的配置更好——猜错会改变权限模型却没有任何提示。
    if (!draftOptions) {
      return;
    }
    // Bugfix: workspace configOptions 描述的是切换前的工作区模型，不能用来校验新 task 的配置。
    // 例如 GLM 的 enabled 会被误下发给刚切换到的其他 provider 模型，导致首条微信消息回调失败。
    const configOptions = await listActiveTaskConfigOptions(context, taskId);
    // 注意这里用 category 精确匹配，而 findSelectConfigOption 允许 id 兜底：
    // 下发路径必须严格，旧格式的 mode 项若 category 不符，说明它不属于当前任务的能力集。
    const modeOption = configOptions.find(
      (option) => option.category === "mode" && option.type === "select",
    );
    // Bot 硬锁 yolo：无论草稿/继承的 mode 是什么，建 task 时一律下发 yolo。
    // 这是 mode 真正进入 agent session 的唯一咽喉，保证任何 bot task 都免交互权限。
    const forcedDraftMode = resolveSupportedDraftMode(
      configOptions,
      context.group ? (draftOptions.mode ?? "default") : BOT_FORCED_MODE,
      draftOptions.provider,
    );
    // 两个分支条件刻意不对称：
    // (1) 群聊无条件下发：即使 forcedDraftMode 为 undefined，也写 default，保证群里永远不是 yolo；
    // (2) 私聊只在 provider 确实支持该 mode 时才下发，避免对不支持的 provider 调 setMode。
    if ((modeOption?.id && forcedDraftMode) || context.group) {
      const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
      await zcodeTaskService.setMode({
        taskId,
        mode: (forcedDraftMode ?? "default") as ZCodeTaskMode,
      });
    } else if (modeOption?.id) {
      // provider 不支持 yolo（非 ZCode Agent）：保持其自身默认模式，避免首条消息回调失败。
      // debug 而非 warn：这是预期内的能力差异，不是异常，warn 会在每次建任务时刷屏。
      botsLogger.debug(
        traceId,
        `skip forced yolo mode unsupported provider=${draftOptions.provider}`,
      );
    }
  }

  // 会话级 key：botId + provider + 会话标识 + (话题) + (群内发送者)。
  // 三段可变部分的取舍：
  // - chatId 优先 providerUserId：群聊必须有 chatId 才能定位群，私聊回退到用户 id；
  // - threadId 只在存在时追加：普通会话不占位，否则同一会话会出现「带空段」与「不带段」两种 key；
  // - 群聊额外追加 providerUserId：群 key 是「群维度」的，而 pending 菜单是「人维度」的，
  //   缺这一段会让 A 群成员点开的菜单覆盖 B 成员的待选项。
  function getActorContextKey(actor: BotActor): string {
    return [
      actor.botId,
      actor.provider,
      actor.chatId?.trim() || actor.providerUserId,
      ...(actor.threadId ? [actor.threadId] : []),
      ...(actor.chatType === "group" ? [actor.providerUserId] : []),
    ].join("::");
  }

  // 清掉某 bot 的私聊待选菜单（私聊新建任务时调用）。
  // 匹配规则与 getActorContextKey 严格互逆：私聊 key 是 botId::provider::target，
  // 去掉前两段后只剩 1 段；群 key 会多出群段与发送者段，因此「剩余段数 === 2」才是私聊。
  // [权衡] 用段数判断而不是前缀 + 白名单：key 里可能出现带 :: 的 chatId，
  // 段数判断能在结构上排除群 key，避免误清其他群的菜单。
  function clearPrivatePendingSelectionsForBot(botId: string): void {
    // 私聊新建不能清掉群成员的菜单；群 key 额外包含发送者这一段。
    const matchesBot = (contextKey: string): boolean =>
      contextKey === botId ||
      (contextKey.startsWith(`${botId}::`) &&
        contextKey.slice(botId.length + 2).split("::").length === 2);
    // 三张表必须一起清：它们分别对应 /task、/workspace 与其他选择，
    // 只清一张会让另一张的旧 pending 在后续文本输入时被误解析。
    for (const contextKey of pendingSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        pendingSelectionsByContext.delete(contextKey);
      }
    }
    for (const contextKey of pendingTaskSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        pendingTaskSelectionsByContext.delete(contextKey);
      }
    }
    for (const contextKey of pendingWorkspaceSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        pendingWorkspaceSelectionsByContext.delete(contextKey);
      }
    }
  }

  // 解析某会话的待选菜单选项（按钮回调路径使用）。三重校验缺一不可：
  // (1) 没有待选：直接 null；
  // (2) action 不匹配：说明回调来自一条已经过期的旧卡片，不能按新菜单解析（INV-11）；
  // (3) 选项值不存在：可能菜单已被替换，同样视为过期。
  // 命中后才删除待选：先删会让解析失败的回调把菜单「用掉」，用户再点也无效。
  function resolvePendingSelectionOption(
    actor: BotActor,
    action: SelectionPrompt["action"],
    value: string,
  ): SelectionPrompt["options"][number] | null {
    const actorContextKey = getActorContextKey(actor);
    const selection = pendingSelectionsByContext.get(actorContextKey);
    if (selection?.action !== action) {
      return null;
    }
    const option = resolveOptionByValue(selection.options, value);
    if (option) {
      pendingSelectionsByContext.delete(actorContextKey);
    }
    return option;
  }

  // 清空某会话的全部待选状态。三个 Map 分别对应不同命令来源，
  // 之所以不合并成一张表，是因为它们的生命周期不同（/workspace 的待选可以跨任务存在）。
  function clearPendingSelection(actor: BotActor): void {
    const actorContextKey = getActorContextKey(actor);
    pendingSelectionsByContext.delete(actorContextKey);
    pendingTaskSelectionsByContext.delete(actorContextKey);
    pendingWorkspaceSelectionsByContext.delete(actorContextKey);
  }

  // 把「用户回复的纯文本」翻译成显式命令，仅用于微信的 pending selection。
  // INV-11：选项 id 在渲染 → 点击 → 回调之间必须稳定，因此除 permission.respond 外
  // 一律把 option.id 原样放进命令 value，绝不做二次编码或按 label 反查。
  // [失败路径] 任何一步不匹配都先 clearPendingSelection 再返回 null：
  // 留着一份过期的待选，会让用户的下一句话又被当成菜单选择，形成连续误解。
  function resolvePendingSelectionCommand(actor: BotActor, value: string): BotCommand | null {
    const actorContextKey = getActorContextKey(actor);
    const selection = pendingSelectionsByContext.get(actorContextKey);
    if (!selection) {
      return null;
    }
    if (actor.provider !== "weixin") {
      // Bugfix: 只有微信没有结构化选项，只能靠“回复数字”承接 pending selection。
      // Telegram/飞书等 provider 有按钮回调，普通文本不应被隐式解析成菜单选择。
      clearPendingSelection(actor);
      return null;
    }
    if (!isSelectionIndexValue(value)) {
      // Bugfix: /task 等列表命令会留下 pending selection。
      // 旧逻辑允许普通文本按 label 命中选项，用户输入与 task 标题同名的消息时会被误切 task。
      // 隐式选择只接受纯数字；按 id/label 选择仍通过显式 /task <value> 等命令完成。
      clearPendingSelection(actor);
      return null;
    }
    const option = resolveOptionByValue(selection.options, value);
    if (!option) {
      clearPendingSelection(actor);
      return null;
    }
    // 只在确认能翻译成命令后才删除待选，保证「数字越界」不会消耗掉菜单。
    pendingSelectionsByContext.delete(actorContextKey);
    switch (selection.action) {
      // queue.cancel 是唯一走命令解析器的分支：取消队列卡的值本身就是一条命令文本，
      // 其余分支都是结构化命令，直接构造避免被文本解析器二次解释。
      case "queue.cancel":
        return parseBotCommand(option.id);
      case "workspace.set":
        return { type: "workspace.set", value: option.id };
      case "model.provider.set":
        return { type: "model.provider.set", value: option.id };
      case "model.set":
        return { type: "model.set", value: option.id };
      case "mode.set":
        return { type: "mode.set", value: option.id };
      case "thoughtLevel.set":
        return { type: "thoughtLevel.set", value: option.id };
      case "task.set":
        return { type: "task.set", value: option.id };
      case "reply.set":
        return { type: "reply.set", value: option.id };
      // permission.respond 用用户的原始输入而不是 option.id：
      // 权限选项里含「允许并记住」这类需要保留用户原话语义的项，且 id 可能本身就等于输入。
      case "permission.respond":
        return { type: "permission.respond", value };
      case "elicitation.respond":
        return { type: "elicitation.respond", value: option.id };
    }
  }

  // 判断是否使用「可变的临时交互卡」：四个条件全部成立才启用。
  // 降级语义：任一不满足就走普通消息，宁可牺牲交互体验也不能让回复丢失（INV-09 的同类原则）。
  // 同时检查 create 与 update 两个能力：只能建不能改，等于每步交互都换一张卡，会产生撤回痕迹。
  function shouldUseTransientInteractionCard(bot: BotConfig, user: BotConfig): boolean {
    const adapter = providers[bot.provider];
    return (
      isFeishuBotProvider(bot.provider) &&
      normalizeBotReplyGranularity(bot.provider, user.replyMode) === "streaming_card" &&
      Boolean(adapter?.createTransientInteractionCard) &&
      Boolean(adapter?.updateTransientInteractionCard)
    );
  }

  // 写入/更新会话当前那张临时交互卡。
  // 有卡片就原地 update，没有才 create：单卡身份是这套交互的核心不变量，
  // 每次交互都 POST 新卡会留下「卡片已撤回」的痕迹，也会打断用户的阅读位置。
  // [资源] handle 保存在 transientInteractionCards 中，由 finalize 或 dispose 清理；
  // 这里不设 TTL，因为同一会话的下一张卡会复用同一 handle，泄漏面被会话数封顶。
  async function upsertTransientInteractionCard(
    bot: BotConfig,
    actor: BotActor,
    taskId: string,
    message: BotOutboundMessage,
  ): Promise<void> {
    const adapter = providers[bot.provider];
    const key = getActorContextKey(actor);
    const existing = transientInteractionCards.get(key);
    if (existing) {
      // 修复原因：交互推进时 POST 新卡再 DELETE 旧卡会显示撤回痕迹。
      // callback token 更新失败后的降级路径也只能 PATCH 原 message_id，保持单卡身份稳定。
      // 用 existing.bot 而不是入参 bot：卡片归属的 bot 身份不能因为后续消息换了配置对象而漂移。
      await adapter?.updateTransientInteractionCard?.(existing.bot, existing.handle, message);
      return;
    }
    const handle = await adapter?.createTransientInteractionCard?.(bot, message);
    // 创建失败静默返回：调用方还有普通消息兜底路径，这里抛错会让整条交互回复失败。
    if (!handle) {
      return;
    }
    transientInteractionCards.set(key, { bot, taskId, handle });
  }

  // 交互结束时的收尾：把卡片改成「无控件」终态并释放句柄，返回是否真的处理过卡片。
  // 刻意不撤回卡片：撤回会让问答与计划从聊天历史消失，用户无法回看自己做过什么决策。
  // [失败路径] update 失败只 warn：终态更新是尽力而为，不能因为卡片过期而阻塞任务结果投递；
  // finally 必须删除句柄，否则同一会话的下一次交互会一直 PATCH 一张已失效的旧卡。
  async function finalizeTransientInteractionCard(
    actor: BotActor,
    fallback: BotOutboundMessage,
  ): Promise<boolean> {
    const key = getActorContextKey(actor);
    const existing = transientInteractionCards.get(key);
    // 没有卡片说明本次交互从未用临时卡（降级到了普通消息），返回 false 让调用方走普通发送。
    if (!existing) {
      return false;
    }
    const adapter = providers[existing.bot.provider];
    try {
      // 修复原因：交互完成后撤回卡片会让问答和计划从聊天历史消失，用户无法回看
      // 决策上下文。终态只更新为无控件卡片并释放运行时句柄，后续交互会创建新卡。
      await adapter?.updateTransientInteractionCard?.(existing.bot, existing.handle, fallback);
    } catch (error) {
      botsLogger.warn(
        undefined,
        `finalize interaction card failed bot=${existing.bot.id} task=${existing.taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      // 无论成功与否都释放本地句柄：留着它只会让下一次交互去更新一张平台侧可能已经失效的卡片。
      transientInteractionCards.delete(key);
    }
    return true;
  }

  // 群投递节流器与「每个群一个 sender」的注册表在模块初始化时创建；
  // sender 按群维度缓存，使节流窗口与队列卡状态在多次投递之间保持连续。
  const waitForGroupDeliverySlot = createGroupDeliveryThrottle();
  const groupDeliverySenders = new Map<string, ReturnType<typeof createGroupResultDelivery>>();
  function getGroupDeliverySender(bot: BotConfig, chatId: string, threadId?: string) {
    // [资源] 群发送节流器按 provider:chatId 预留 250ms 发送额度：它只推迟发送时刻，
    // 既不缓存消息也不判断业务状态。把限流做成纯延时而非队列，是因为投递事实已由
    // deliveries 持久记录承担，再叠一层内存待发队列等于造出第二份未发送事实（INV-07）。
    // groupDeliverySenders 按会话 key 缓存 sender，使同一会话的所有投递共享 inFlight 去重表。
    // 职责：为「bot + 群 chatId + 话题 threadId」构造唯一的群结果投递器（sender）。
    // 身份口径：key 由 getBotConversationKey 生成，只含群会话维度，绝不含发送者 providerUserId；
    // 若用发送者做 key，同群多人会各持一份 inFlight，deliveryId 去重直接失效（INV-07）。
    // 副作用：sender 内部会读 repo、写 deliveries、调 provider 发消息、发 bots:group-state 广播。
    // 失败语义：sender 自身不抛业务错误，只把结果推进为 failed/invalidated/unknown 三种终态。
    // 维护 INV-01（owner 与 appId 复核）、INV-07（幂等与终态）、INV-10（状态原子写）。
    const key = getBotConversationKey({ botId: bot.id, chatType: "group", chatId, threadId });
    // 按会话复用已有 sender：createGroupResultDelivery 的 inFlight 表是实例内状态，
    // 每次新建都会让同一 deliveryId 的并发重试各自为政，同一结果被发两遍。
    // [权衡] 该缓存不淘汰（进程内每会话一份），换的是跨重连、跨任务稳定的去重表。
    const existing = groupDeliverySenders.get(key);
    if (existing) return existing;
    // authorized 是「每次物理发送前」的闸门，而不是构造时的一次性判断：
    // sender 的 retry/fallback 循环可能跨秒级，owner、任务归属、授权代际随时会变。
    // 返回 false 时 groupResultDelivery 会把记录写成 invalidated 终态并停止重试（INV-07）。
    const authorized = async (result: BotGroupDelivery): Promise<boolean> => {
      // [并发] state 与 config 是两次独立读取，不构成原子快照：中间若发生禁用或改绑，
      // 判定可能基于旧 config + 新 state。代价可接受，因为下一次复核会纠正；
      // 要真正原子就得让 repo 提供跨文件事务，而这两份事实本就分文件存储（INV-10）。
      const state = (await repo.readState()).bots[key];
      const currentBot = findBot(await repo.readConfig(), bot.id);
      // 下面八个条件缺一不可，每个都对应一次真实的越权或错投场景：
      return Boolean(
        // 1) bot 仍启用：禁用后继续发送，等于用已撤销的凭据触达群成员。
        currentBot?.enabled &&
        // 2) appId 绑定：同一 bot 可能换过飞书应用，旧应用产生的富内容只能由旧应用回发，
        //    否则会以新应用身份发到别的租户会话。result 未带 appId 的纯文本不受此限。
        (!result.appId || result.appId === currentBot.feishuAppId) &&
        // 3) contentParts 是频道原生回复的富内容，只在该输入仍可能被执行时补发：
        //    输入已 cancelled/discarded/stopped 后再发，群里会出现一张没有任务对应的卡片。
        //    这里读的是 inputs 的 progress.status，而不是 deliveries 自身状态，两者语义不同。
        (!result.contentParts ||
          !["cancelled", "discarded", "stopped"].includes(
            state?.group?.inputs?.[result.sourceCommandId ?? ""]?.progress?.status ?? "",
          )) &&
        // 4) 群会话仍启用：/leave 或重建后 deliveries 仍留在磁盘上，但不得再投递。
        state?.group?.enabled &&
        // 5) owner 必须等于当前 bot 身份（INV-01）：owner 是群控制权的唯一可信来源；
        //    若改成看「最近发言人」，任何群成员发一句话就能把结果引到自己身上。
        state.group.ownerId === currentBot.providerUserId &&
        // 6) activeTaskId 仍是该结果所属任务：群切换任务后，迟到的旧结果必须作废，
        //    否则旧任务的回复会挂在新任务上下文里，用户会误以为是新任务的输出。
        state.activeTaskId === result.taskId &&
        // 7) 记录未被标记 invalidated：invalidated 是终态，重试不得把它复活（INV-07）。
        state.group.deliveries?.[result.id]?.status !== "invalidated" &&
        // 8) authorizationId 一致：群重新授权会换 id，旧授权下的结果不得跨代投递。
        //    result 无 authorizationId 时跳过，是为了兼容加该字段之前落盘的旧记录。
        (!result.authorizationId || result.authorizationId === state.group.authorizationId),
      );
    };
    // 四个依赖的分工：read/write 负责持久事实，authorized 负责发送前复核，send 只做一次物理发送。
    // 状态机放在 createGroupResultDelivery 内，保证 pending→unknown→sent/failed/invalidated
    // 的每次推进都伴随一次磁盘写入，崩溃后能据此判断「可能已发出」。
    const sender = createGroupResultDelivery({
      // onSettled 在 sender 的 finally 中执行：无论最终是 sent、failed、unknown 还是 invalidated，
      // 都会广播一次让 UI 拿到最新状态。广播自身失败被吞掉——UI 同步不能反过来改写投递结果。
      onSettled: async () => {
        // 广播体只带 botId + chatId，不带整份状态：订阅方按 repo 自行取数，
        // 避免广播载荷演变成第二份状态事实（INV-10 的投影原则）。
        await deps.broadcastService
          ?.send({ channel: "bots:group-state", payload: { botId: bot.id, chatId } })
          .catch(() => undefined);
      },
      // read 每次回源磁盘而不是读内存：进程重启后 sender 必须看到上次写入的 unknown，
      // 才能判断「可能已发出」，而不是当成未发送重发一遍（INV-07）。
      // 只有 failed 且显式 retry 的记录才允许真正重发。
      read: async (id) => (await repo.readState()).bots[key]?.group?.deliveries?.[id],
      authorized,
      // write 是投递状态的唯一落盘路径：unknown/sent/failed/invalidated 都经由这里，
      // pending 只是 sender 入参的内存初值，从不单独落盘。
      // [事务] 读改写整体挂到 stateWriteTail 串行，与 serializeStateWrite 共用同一条链，
      // 防止两个 bot 的整份状态互相覆盖（INV-02/INV-10）。
      write: async (result) => {
        // [并发] 先 catch 再 then：前一个写入失败不能中断后续写入，否则一次磁盘抖动就让
        // stateWriteTail 永久 rejected，之后所有状态写都直接失败。
        const operation = stateWriteTail
          .catch(() => undefined)
          .then(async () => {
            // [事务] 在链内重新 readState，而不是复用外层结果：排队期间其他写入可能已提交，
            // 拿旧快照写回等于把这些变更整体回滚。
            const state = await repo.readState();
            const context = state.bots[key];
            // [失败路径] 群上下文已消失（/leave 或清理）时直接返回：没有 group 就没有 deliveries 容器，
            // 凭空补一个 context 会伪造出未授权的群状态。代价是本次结果无法记录；
            // 但此时也没有群可发，不会造成重复投递。
            if (!context?.group) return;
            // invalidated 的判定必须与 authorized 口径一致，否则会出现「复核放行、写入又标无效」的
            // 自相矛盾记录。四类原因：群停用、任务切换、授权代际变化、已被置为 invalidated。
            const invalidated =
              !context.group.enabled ||
              context.activeTaskId !== result.taskId ||
              (Boolean(result.authorizationId) &&
                context.group.authorizationId !== result.authorizationId) ||
              context.group.deliveries?.[result.id]?.status === "invalidated";
            // [并发] 只替换本 context 的引用，其余 context 原样保留；repo.readState 每次从磁盘重新
            // parse，因此这里的就地赋值不会污染其他调用方持有的状态。
            state.bots[key] = {
              ...context,
              group: {
                ...context.group,
                deliveries: {
                  ...context.group.deliveries,
                  // 已 invalidated 的记录再次进入 write 仍保持 invalidated：终态只能由新的一次投递产生，
                  // 不能被同一条记录的重试覆盖回 sent。
                  [result.id]: invalidated ? { ...result, status: "invalidated" } : result,
                },
              },
            };
            // [事务] writeState 走 atomicWritePrivateTextFile（临时文件 + rename）：崩溃在替换前
            // 磁盘仍是旧状态，替换后是完整新状态，不会留下半份 JSON（INV-10）。
            await repo.writeState(state);
          });
        // [并发] 先把 operation 赋给 stateWriteTail 再 await：若先 await 后赋值，期间进来的
        // 其他写入会挂到旧 tail 上与本操作并行，读改写窗口重新打开。
        stateWriteTail = operation;
        await operation;
        // 写入成功后才广播；广播自身 catch 掉失败，因此不会让 operation reject、污染写入链。
        await deps.broadcastService
          ?.send({ channel: "bots:group-state", payload: { botId: bot.id, chatId } })
          .catch(() => undefined);
      },
      // send 只做一次物理发送，不做重试决策：重试、降级、终态全部由 createGroupResultDelivery 驱动。
      // 两个细节决定正确性：等待额度后必须重新授权；拒绝必须区分「永久拒绝」与「暂不确定」。
      send: async (result) => {
        // [并发] 先取发送额度再复核授权，顺序不能颠倒：等待可能长达数百毫秒，期间 owner 可能
        // 已被换掉或任务已切换；先授权后等待会把这段窗口留成实际发送。
        await waitForGroupDeliverySlot(`${bot.provider}:${chatId}`);
        // [失败路径] deliveryRejected 是「确定性拒绝」信号：sender 收到后写 failed 并停止重试。
        // 若这里抛普通 Error，sender 会写成 unknown，reconcile 时会误以为可能已发送而不再补发。
        if (!(await authorized(result)))
          throw Object.assign(new Error("Group delivery authorization changed"), {
            deliveryRejected: true,
          });
        // 重读 config 而不是复用闭包里的 bot：sender 缓存寿命等于进程寿命，闭包中的凭据与
        // 启用状态可能早已过期；同时取当前 adapter，provider 被置空时能正确拒绝而不是发送。
        const currentBot = findBot(await repo.readConfig(), bot.id);
        const adapter = currentBot && providers[currentBot.provider];
        if (!adapter || !currentBot)
          throw Object.assign(new Error("Bot provider unavailable"), { deliveryRejected: true });
        // contentParts 必须由创建它时的同一个 provider/appId 回发：富内容是频道侧的应用内对象，
        // 换应用发送会落到错误租户，或直接被平台拒绝成一次无意义的失败记录。
        if (
          result.contentParts &&
          (currentBot.provider !== bot.provider || currentBot.feishuAppId !== result.appId)
        )
          throw Object.assign(new Error("Channel reply application changed"), {
            deliveryRejected: true,
          });
        // 发送字段口径，逐项都影响对方看到的结果：
        // botId 用闭包 bot.id，provider 用闭包 bot.provider——若配置改了 provider 而 adapter 来自
        // currentBot，这两个字段会与 adapter 不一致（潜在风险，仅标注）。
        // providerUserId 固定为群 chatId 而不是触发者，否则群回复会变成私聊。
        // deliveryId 透传给 provider，供其服务端幂等或回执关联；
        // replyToMessageId/mentionedUserIds/contentParts 决定引用、@ 与富文本形态。
        return adapter.send(currentBot, {
          botId: bot.id,
          provider: bot.provider,
          providerUserId: chatId,
          text: result.text,
          deliveryId: result.id,
          replyToMessageId: result.replyToMessageId,
          mentionedUserIds: result.mentionedUserIds,
          contentParts: result.contentParts,
          trace: result.trace,
          threadId: result.threadId ?? threadId,
          // [并发] 缺省时兜底读一次 state 取 rootMessageId：sender 构造时未固化根消息，
          // 话题根被重建后仍能回到当前根；多一次磁盘读换的是话题归属正确。
          rootMessageId:
            result.rootMessageId ?? (await repo.readState()).bots[key]?.group?.rootMessageId,
        });
      },
    });
    // 只有构造成功才写入缓存：若 getBotConversationKey 抛错（chatId 为空），
    // 不能留下半初始化的 sender 供后续复用。
    groupDeliverySenders.set(key, sender);
    return sender;
  }

  // 职责：除群结果 sender 之外的所有出站路径（命令回复、错误提示、卡片、定时任务）。
  // 三类分支按代价递增：飞书群任务且带 deliveryId 走持久投递；飞书群普通回复只受节流；
  // 其余 provider 直接交给 adapter。
  // 副作用：可能写 deliveries、读 config/state、加载凭据、调 provider。
  // 失败语义：adapter.send 失败会记录 runtime 投递错误后原样抛出，
  // 由调用方释放入站占位（INV-03）。
  async function sendOutbound(
    bot: BotConfig,
    message: BotOutboundMessage,
    authorize?: () => Promise<boolean>,
  ): Promise<void> {
    // conversationThreadId 的口径：字段存在（哪怕是 null）表示调用方明确指定了会话话题，
    // 不存在才回落到 threadId。这里用 !== undefined 而不是 ??，是因为 null 表达「回到主群」；
    // 被 ?? 吞掉就会继承旧话题，回复跑到错误的话题下。
    const conversationThreadId =
      message.conversationThreadId !== undefined
        ? (message.conversationThreadId ?? undefined)
        : message.threadId;
    // 飞书群任务 + deliveryId 才进入持久投递：deliveryId 是跨重启的幂等键，
    // 没有它就无法在重试/重连时判断这条是否已发过，只能走一次性直接发送。
    if (isFeishuBotProvider(bot.provider) && message.groupTaskId && message.deliveryId) {
      const parts = splitFeishuText(message.text);
      // 读群状态只为取 authorizationId 兜底（message.groupCard 可能没带该字段）；
      // 这次读与后续发送不构成事务，authorized 会在真正发送前再复核一次。
      const group = (await repo.readState()).bots[
        getBotConversationKey({
          botId: bot.id,
          chatType: "group",
          chatId: message.providerUserId,
          threadId: message.threadId,
          conversationThreadId: message.conversationThreadId,
        })
      ]?.group;
      // 显式传入的 authorizationId 优先：卡片回调携带的是生成该卡片时的授权代际，
      // 用它才能让「授权已被替换」的迟到卡片被判为无效，而不是当成当前授权放行。
      const authorizationId = message.groupCard?.authorizationId ?? group?.authorizationId;
      // 逐段顺序 await 而不是 Promise.all：片段之间有上下文、@、引用的顺序语义，
      // 并发发送会乱序，且同一时刻的并发请求更容易触发平台限流（INV-07）。
      for (const [index, text] of parts.entries()) {
        // 分片 id 用 sha256(deliveryId:index) 而不是随机值：同一条消息重试时必然得到同一个 id，
        // 从而命中 deliveries 去重；随机 id 会让每次重试都变成一条新记录并被再发一遍。
        const id = createHash("sha256").update(`${message.deliveryId}:${index}`).digest("hex");
        // 状态一律从 pending 起：由 sender 推进到 unknown/sent/failed。
        // 这里直接写 sent 会把「尚未发出」记成已完成，崩溃后无法补偿。
        const result: BotGroupDelivery = {
          authorizationId,
          id,
          taskId: message.groupTaskId,
          sourceCommandId: message.groupSourceCommandId,
          text,
          replyToMessageId: message.replyToMessageId,
          // @ 只挂在第一个分片：重复 @ 会在群里反复提醒同一批人，后续分片通常只是续文。
          mentionedUserIds: index === 0 ? message.mentionedUserIds : undefined,
          threadId: message.threadId,
          rootMessageId: message.rootMessageId,
          status: "pending",
          updatedAt: Date.now(),
        };
        // 每个分片都 await sender 完成：sender 内的 inFlight 只去重同 id，串行调用才保证顺序。
        // 发送失败由 sender 记入 deliveries 并正常返回，因此循环继续；写入失败才会中断整个循环。
        await getGroupDeliverySender(bot, message.providerUserId, conversationThreadId)(result);
      }
      return;
    }
    // oc_ 前缀是飞书群会话 id 的约定；这类目标即使没有 deliveryId 也要共用发送额度，
    // 否则命令回复与结果投递会同时打满平台速率限制。
    if (isFeishuBotProvider(bot.provider) && message.providerUserId.startsWith("oc_")) {
      await waitForGroupDeliverySlot(`${bot.provider}:${message.providerUserId}`);
    }
    // 定时任务也使用稳定群目标；等待发送额度之后重新检查启用状态。
    // 等完额度再执行 authorize：定时任务可能在排队期间被关闭或换了 owner，
    // 先判后等会让「关闭之后仍然发出通知」成为可能（INV-01）。
    if (authorize && !(await authorize())) return;
    // 有 groupTaskId 却走直接发送时，必须复核群未易主：这条路径没有 deliveries 记录兜底，
    // 一旦发错无法回滚，只能在发送前把状态条件全部对齐。
    if (isFeishuBotProvider(bot.provider) && message.groupTaskId) {
      const groupState = (await repo.readState()).bots[
        getBotConversationKey({
          botId: bot.id,
          chatType: "group",
          chatId: message.providerUserId,
          threadId: message.threadId,
          conversationThreadId: message.conversationThreadId,
        })
      ];
      // 与 authorized 同口径：config 与 state 分两次读，不保证来自同一时刻的快照。
      const currentBot = findBot(await repo.readConfig(), bot.id);
      // 四个条件任一不满足就静默返回：定时通知的语义是「任务仍归本群才通知」。
      // 不抛错是因为调用方多为后台触发，错误只会变成噪音日志。
      if (
        !currentBot?.enabled ||
        !groupState?.group?.enabled ||
        groupState.group.ownerId !== currentBot.providerUserId ||
        groupState.activeTaskId !== message.groupTaskId
      )
        return;
    }
    // [失败路径] adapter 为空（discord/wecom 未实现）时直接返回：出站是 fire-and-forget，
    // 抛错会打断调用方的回复循环；代价是消息被静默丢弃，只能靠 runtime 状态诊断。
    const adapter = providers[bot.provider];
    if (!adapter) {
      return;
    }
    // 微信/iLink 的回复需要 providerContextToken，它来自该会话最近一次入站消息，
    // 因此必须按 chat 维度从 credentialService 取，不能复用构造时的 bot 级凭据。
    if (bot.provider === "weixin") {
      const token = await deps.credentialService.load(
        weixinContextKey(bot, message.providerUserId),
      );
      // 用新对象覆盖而不是改写 message：message 可能被调用方复用（多条回复共享同一份）。
      if (token) message = { ...message, providerContextToken: token };
    }
    // 留出 handle 是为了后面把 provider 回执挂到排队卡；失败时先记账再抛出。
    let handle: Awaited<ReturnType<BotProviderAdapter["send"]>>;
    try {
      handle = await adapter.send(bot, message);
      // 成功时用 undefined 清掉 runtime 上一次的投递错误，避免 UI 长期显示已恢复的故障。
      onDeliveryResult(bot, undefined);
    // [失败路径] 投递错误要区分「连接正常但回复没发出去」：onDeliveryResult 只更新 runtime
    // 诊断，不改变 bot 连接态；随后原样 throw，让调用方 releaseInboundDelivery 后允许重投。
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // 微信的失败通常不是网络问题而是缺少会话上下文 token：给出可操作提示而不是裸错误。
      const locale = await readMessageLocale();
      onDeliveryResult(
        bot,
        bot.provider === "weixin"
          ? locale === "en-US"
            ? `${detail}. Send a message to the bot in Weixin, then retry.`
            : `${detail}。请在微信给机器人发一条消息后重试。`
          : detail,
      );
      throw error;
    }
    // 取消排队卡发出后，需要把新卡片的 providerMessageId 绑定回 queueCards：
    // 后续状态更新只能按该 id 改卡，绑定失败会让排队卡永远停在初始文案。
    if (
      message.selection?.action === "queue.cancel" &&
      message.groupSourceCommandId &&
      message.groupCard?.taskId &&
      handle?.providerMessageId
    ) {
      // key 必须与 readQueueCardScope 的解析顺序完全一致（botId/chatId/taskId/authorizationId/
      // sourceCommandId/thread 维度）。任一字段口径漂移，后续 mutate 就找不到 scope，卡片静默失联。
      await queueCards
        .attach(
          JSON.stringify([
            bot.id,
            message.groupCard.chatId,
            message.groupCard.taskId,
            message.groupCard.authorizationId,
            message.groupSourceCommandId,
            message.groupCard.conversationThreadId !== undefined
              ? message.groupCard.conversationThreadId
              : message.groupCard.threadId,
          ]),
          handle.providerMessageId,
        )
        // 卡片绑定失败只告警：主回复已经发出，卡住出站流程反而会让用户看不到结果（INV-09 降级）。
        .catch((error) => {
          botsLogger.warn(
            undefined,
            `queue card catch-up failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  }

  // 职责：生成入站投递幂等键，供 markInboundDelivery 占位、releaseInboundDelivery 释放。
  // 键 = botId :: provider :: chatId(或发送者) :: providerMessageId，四段各防一类碰撞：
  // botId 区分「同一条群消息分发给多个 bot」；provider 区分不同渠道的独立 id 空间；
  // chatId/providerUserId 区分群会话与私聊发送者；providerMessageId 才是消息身份。
  // 维护 INV-03：键必须在任何副作用之前生成并占位。
  function buildInboundDeliveryKey(message: BotInboundMessage): string | null {
    // trim 后再判空：部分 provider 会带空白 id，不去空白会让同一条消息产生两个键。
    const providerMessageId = message.actor.providerMessageId?.trim();
    // [失败路径] 无 providerMessageId 就无法幂等，返回 null 让调用方按「不参与去重」处理。
    // 选择 fail-open 而不是拒绝处理：丢消息比偶发重复执行更糟，重复还能被用户中止。
    if (!providerMessageId) {
      return null;
    }
    // 四段 join 的顺序就是身份优先级，改动顺序等于让进程内已占位的键全部失效：
    // 热更新/重载期间会放行一次重复执行。
    return [
      message.actor.botId,
      message.actor.provider,
      // 群消息用 chatId（会话身份），私聊用 providerUserId（发送者身份）：
      // 群里若用发送者，同一条转发在不同人之间会被当成新消息重复执行。
      message.actor.chatId ?? message.actor.providerUserId,
      providerMessageId,
    // [权衡] 分隔符 :: 未转义：provider id 若含 :: 理论上可构造碰撞。
    // 当前各渠道 id 均为字母数字/短横线，保持简单拼接；要修应改为 JSON.stringify 数组。
    ].join("::");
  }

  // 职责：把占位从去重表删除，使同一消息在业务失败后能被 provider 重投再处理（INV-03）。
  // 为什么是 delete 而不是写 0：保留条目仍会命中 has()，等于把这条消息永久吞掉。
  // 调用点：provider 回调 catch、handleInboundMessage 抛错处。
  function releaseInboundDelivery(message: BotInboundMessage): void {
    // 复用同一构造函数，保证「占位」与「释放」用的是逐字节相同的键。
    const deliveryKey = buildInboundDeliveryKey(message);
    // 键为 null 表示本就没占位，既无需释放，也不能凭空删除别人的条目。
    if (deliveryKey) {
      // [权衡] 释放后若该消息其实已成功执行、只是回复发送失败，重投会再执行一次。
      // 这里选「可能重复」而非「可能丢失」：重复可被用户中止，丢失则完全无感。
      recentInboundDeliveryAtByKey.delete(deliveryKey);
    }
  }

  // 职责：按会话把入站处理串行化，避免同一个 pendingElicitation/pendingPermission
  // 被两个并发请求同时读取并各自 respond 一次（INV-04）。
  // 粒度是「会话 + control 通道」而不是「发送者」：pendingElicitation 属于会话，
  // 按发送者分锁会让两个群成员同时消费同一份交互状态。
  // control=true 走独立通道，使 /stop 不被正在等附件或 admission 的普通输入堵住。
  async function enqueueInboundProcessing<T>(
    actor: BotActor,
    task: () => Promise<T>,
    control = false,
  ): Promise<T> {
    // 控制请求独立串行，不能被等待附件或 admission 的普通输入挡住。
    // 键里显式加 :control 后缀：控制与普通处理各自一条队列，互不排队。
    // 群 key 由 getBotConversationKey 生成（botId/chatId/threadId），天然不含发送者。
    const actorContextKey = `${getBotConversationKey(actor)}${control ? ":control" : ""}`;
    // previous 为空表示当前无人在处理；否则本请求必须排在它后面。
    const previous = inboundProcessingQueuesByContext.get(actorContextKey) ?? Promise.resolve();
    // releaseQueue 由当前排队者自己触发，用来放行下一个等待者。
    let releaseQueue = (): void => undefined;
    // [并发] 关键顺序：先用 previous 链出一个「永不 resolve 的占位 Promise」并立刻写入 map，
    // 再 await previous。若先 await 再写 map，后来者在等待窗口内仍看到旧 previous，
    // 两个请求会同时通过，串行化直接失效。
    const current = previous
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            releaseQueue = resolve;
          }),
      );
    // 立刻发布 current，后来者只能排在本任务之后。
    inboundProcessingQueuesByContext.set(actorContextKey, current);
    // 等待前驱完成且不关心其成败：前驱失败由它自己的调用方处理，不能传染给本任务。
    await previous.catch(() => undefined);
    try {
      // Bugfix: 同一个用户可能连续点击 AskUserQuestion 按钮或快速回复多条消息。
      // 这里按 actor 串行化入站处理，避免两个并发请求同时读取同一个 pendingElicitation 并重复 respondElicitation。
      return await task();
    // 无论 task 成功或抛错都要放行，否则一次异常会让该会话的入站队列永久卡死。
    } finally {
      releaseQueue();
      // [并发] 仅当 map 仍指向自己时才删除：若后来者已把 current 换成新的链，
      // 删除会把后来者的队列从 map 摘掉，第三个请求就会与它并行。
      if (inboundProcessingQueuesByContext.get(actorContextKey) === current) {
        inboundProcessingQueuesByContext.delete(actorContextKey);
      // [失败路径] 队列没有超时：某个 task 若在网络调用上永久挂起，同会话后续输入会一直等待。
      // 不加超时是为了避免超时后两个请求同时处理同一交互；代价是故障时会话级阻塞。
      }
    }
  }

  // 职责：按 TTL 清理入站去重表，避免 Map 随消息量无限增长。
  // [权衡] 用「每次 mark 时同步全表扫描」而不是定时器：表规模被 TTL 限制在分钟级消息量，
  // 扫描成本可忽略；而定时器在 disposeAll 之后仍需额外清理（INV-12）。
  function pruneRecentInboundDeliveryDedupe(now: number): void {
    // 边遍历边删除在 Map 上是安全的：删除已访问项不会干扰后续迭代。
    for (const [key, at] of recentInboundDeliveryAtByKey) {
      // TTL 取 2 分钟，覆盖各 provider 的重试/重投窗口；调小会放行真实重投，
      // 调大会把「用户主动重发」也误判为重复（实际几乎不会复用同一个 id）。
      if (now - at >= BOT_INBOUND_DELIVERY_DEDUPE_TTL_MS) {
        // 用 >= 而非 >：恰好到期的条目就该释放，边界上多留一刻没有意义。
        recentInboundDeliveryAtByKey.delete(key);
      }
    }
  }

  // 职责：在任何业务副作用之前为一条入站消息占位；true 表示首次见到，false 表示重复（INV-03）。
  // 调用点位于 provider 回调最前段，早于附件下载、admission、任务创建。
  // 未命中时只写内存 Map、不落盘：进程重启后去重窗口失效，接受一次重放。
  function markInboundDelivery(message: BotInboundMessage): boolean {
    // 统一取一次 now，供清理与写入共用，避免两次 Date.now 跨越 TTL 边界造成自相矛盾。
    const now = Date.now();
    // 先清理再判重：过期条目必须先释放，否则同一 id 在 TTL 之后永远无法再次处理。
    pruneRecentInboundDeliveryDedupe(now);
    const deliveryKey = buildInboundDeliveryKey(message);
    // [失败路径] 无键时 fail-open 返回 true：宁可重复执行也不静默丢弃；
    // 与 releaseInboundDelivery 的 null 分支成对，保证「没占位就没释放」。
    if (!deliveryKey) {
      return true;
    }
    // 命中即视为重复，且不刷新时间戳：持续重投若不断续期，窗口会变成永久，
    // 这条消息就再也进不来。
    if (recentInboundDeliveryAtByKey.has(deliveryKey)) {
      return false;
    }
    // Bugfix: 飞书 WebSocket 可能重投同一条 im.message.receive_v1，微信/Telegram 也可能在重试后重放同一 message id。
    // 普通消息有创建/发送任务的副作用，必须在进入业务处理前按 provider message id 幂等，避免同一句 hello 被执行两轮。
    // [并发] 从 has 到 set 之间没有 await，Node 单线程下不会被其他消息插入，
    // 因此这里的 check-then-set 是原子的；未来若在两步之间加入任何 await，
    // 必须改成显式互斥，否则同一消息会被处理两次。
    recentInboundDeliveryAtByKey.set(deliveryKey, now);
    return true;
  }

  // 职责：给「本次入站消息」加 typing 指示（飞书为消息上的 Typing reaction）。
  // 与 startTyping 的区别：这条不登记生命周期，只发一次，失败必须完全吞掉。
  async function sendTyping(bot: BotConfig, actor: BotActor): Promise<void> {
    const adapter = providers[bot.provider];
    // typing 目标是会话（群 chatId）而不是发送者：指示器显示在群会话上。
    const targetId = actor.chatId ?? actor.providerUserId;
    // 没有 sendTyping 或没有目标时静默返回：并非所有 provider 支持 typing。
    if (!adapter?.sendTyping || !targetId) {
      return;
    }
    // [失败路径] 吞掉异常：typing 是装饰性副作用，失败不能阻塞真正的入站处理。
    await adapter
      .sendTyping(bot, {
        providerUserId: targetId,
        providerMessageId: actor.providerMessageId,
        providerContextToken: actor.providerContextToken,
      })
      .catch(() => undefined);
  }

  // 职责：短命令处理完后，删除本次入站消息上的 Typing reaction。
  // 为什么要显式停：飞书 sendTyping 只针对消息加 reaction，不依赖「多久没说话」，
  // 不删会一直挂在那条消息上，直到所属任务结束或下一条命令触发清理。
  async function stopInboundTyping(bot: BotConfig, actor: BotActor): Promise<void> {
    const adapter = providers[bot.provider];
    // 与 sendTyping 同口径：会话目标 + 原始 messageId。
    const targetId = actor.chatId ?? actor.providerUserId;
    // 缺 providerMessageId 无法定位 reaction；缺 stopTyping 说明 provider 无此语义。
    if (!adapter?.stopTyping || !targetId || !actor.providerMessageId) {
      return;
    }
    // 若同一 messageId 上还挂着长任务的 typingTarget，说明它属于运行中任务；
    // 这里提前删除会让长任务在剩余时间里失去「正在处理」提示。
    const isLongRunningTyping = Array.from(typingTargets.values()).some(
      (typing) =>
        typing.bot.id === bot.id && typing.target.providerMessageId === actor.providerMessageId,
    );
    // 交给 stopTyping 在任务结束时释放；本函数只负责短命令路径。
    if (isLongRunningTyping) {
      return;
    }
    // Bugfix: 飞书 sendTyping 只负责给本次入站消息加 Typing reaction。
    // 短命令回复发送完成后必须按同一 messageId 显式删除，避免依赖定时兜底或等下一条命令清理。
    // [失败路径] 删除失败仅吞掉：残留 reaction 由任务终态清理或用户下一条消息覆盖。
    await adapter
      .stopTyping(bot, {
        providerUserId: targetId,
        providerMessageId: actor.providerMessageId,
        providerContextToken: actor.providerContextToken,
      })
      .catch(() => undefined);
  }

  // 职责：为某个 taskId 启动 typing 生命周期，两条互斥实现：
  // 1) adapter.startTyping：provider 自己续期，只需在结束时 stop；
  // 2) adapter.sendTyping + 4s 定时器：每次发一次性指示，靠高频重复维持「正在输入」。
  // [资源] 两条路径都必须在 stopTyping/disposeAll 释放，否则定时器与 provider 侧状态泄漏（INV-12）。
  function startTyping(bot: BotConfig, actor: BotActor, taskId: string): void {
    const adapter = providers[bot.provider];
    // 与 sendTyping 一致：群用 chatId，私聊用发送者。
    const targetId = actor.chatId ?? actor.providerUserId;
    // [资源] 双重存在性检查：typingIntervals 有值说明有定时器在跑，typingTargets 有值说明
    // 已登记 provider 生命周期。若允许重复进入，后一次会覆盖 Map 条目，前一个 interval
    // 失去引用后永远无法 clearInterval——进程内永久打点。
    if (!adapter || !targetId || typingTargets.has(taskId) || typingIntervals.has(taskId)) {
      return;
    }
    // 固化发送目标而不是每次重读 actor：任务运行期间用户可能切设备或掉线，
    // typing 应继续挂在发起任务的那条消息与那个会话上。
    const target: BotTypingTarget = {
      providerUserId: targetId,
      providerMessageId: actor.providerMessageId,
      providerContextToken: actor.providerContextToken,
    };
    // provider 托管模式：登记后立即返回，不占用定时器。
    // [并发] 记录 target 必须先于发起调用，否则 stopTyping 可能先到，找不到条目而漏停。
    if (adapter.startTyping) {
      typingTargets.set(taskId, { bot, target });
      // 首次启动失败被吞掉：后续 stopTyping 仍会尝试停止，失败不影响任务本体。
      void adapter.startTyping(bot, target).catch(() => undefined);
      return;
    }
    // 轮询模式：先立即发一次（用户马上看到反馈），再按 4s 周期续期。
    // 4 秒小于各 provider 的 typing 失效窗口；调大用户会看到指示器熄灭后再亮起。
    if (adapter.sendTyping) {
      void adapter.sendTyping(bot, target).catch(() => undefined);
      // [资源] interval 句柄必须以 taskId 存入 typingIntervals：它是对外唯一可清理的引用，
      // 只存在闭包里等于无法回收（disposeAll 靠遍历该 Map 清理）。
      typingIntervals.set(
        taskId,
        // 回调内每次重新取 adapter.sendTyping?：发送期间 provider 被替换或置空时静默跳过，
        // 而不是让 interval 因调用 undefined 抛错。
        setInterval(() => {
          void adapter.sendTyping?.(bot, target).catch(() => undefined);
        }, BOT_TYPING_INTERVAL_MS),
      );
    }
  }

  // 职责：释放某个任务的 typing 生命周期，两种实现都覆盖；对不存在/重复调用幂等。
  // 由任务终态事件、短命令结束、disposeAll 共同调用。
  function stopTyping(taskId: string): void {
    const activeTyping = typingTargets.get(taskId);
    // 先删 Map 再调用 stop：删除是同步的，重入调用不会重复 stop，也不会读到半清理状态。
    if (activeTyping) {
      typingTargets.delete(taskId);
      const adapter = providers[activeTyping.bot.provider];
      // [资源] provider 侧停止是尽力而为：失败/不支持时指示器会在其自身 TTL 后消失，
      // 不能因此抛错打断任务终态处理。
      void adapter?.stopTyping?.(activeTyping.bot, activeTyping.target).catch(() => undefined);
    }
    // 两条生命周期互斥，但这里仍分别处理：状态异常时并存也能全部释放。
    const intervalId = typingIntervals.get(taskId);
    // 没有 interval 说明走的是 provider 托管模式，前半段已完成清理。
    if (!intervalId) {
      return;
    }
    // [资源] clearInterval 必须在 delete 之前：先删后清会留下一个已失去引用、
    // 只能等进程退出的定时器。
    clearInterval(intervalId);
    typingIntervals.delete(taskId);
  }

  // 职责：把流式事件投影成「每个任务一行最新进展」，供 /status 展示。
  // 为什么需要这份内存投影：/status 要在 assistant 消息落盘前就能回答「现在在做什么」，
  // 而任务快照是滞后的。
  // 它不是第二份任务事实：只有 kind + text，随流写入、任务终态即删除。
  function updateLiveStatusProgress(event: ZCodeStreamEvent): void {
    // 只处理文本增量：工具事件走下面的分支；其余事件（终态、错误、权限）与本投影无关。
    if (event.type === "agent_message_chunk" || event.type === "agent_thought_chunk") {
      // 归一化会 trim 并压缩所有空白：progress 必须是单行，否则 /status 排版会被换行打散。
      const text = normalizeStatusProgressText(event.content);
      // 空增量直接忽略而不是清空：流式分片常出现纯空白，清空会让 Progress 短暂变成空白。
      if (!text) {
        return;
      }
      // message 与 thought 分 kind：两者语义不同（对用户说的话 vs 内部推理），
      // 混在一条里会让 /status 把推理内容当成最终回复展示。
      const kind = event.type === "agent_message_chunk" ? "message" : "thought";
      // 读上一次的值，用于「同 kind 才拼接」的判断。
      const previous = liveStatusProgressByTaskId.get(event.taskId);
      liveStatusProgressByTaskId.set(event.taskId, {
        kind,
        // [权衡] 截断保留尾部 1000 字符而不是头部：/status 关心「现在进行到哪」，
        // 保留开头等于永远展示第一条增量；代价是长任务看不到早期上下文。
        text: truncateLiveStatusProgressText(
          // kind 变化时从头开始：把 thought 拼到 message 后面会产生「用户可见回答 + 内部推理」
          // 混排的假文本；不拼接也顺带限制了单条文本的增长。
          previous?.kind === kind ? `${previous.text}${text}` : text,
        ),
      });
      return;
    }
    // 工具调用直接覆盖而不是累积：同一任务的工具调用可能成百上千，累积既超长也无信息量；
    // 只保留最近一次，恰好对应「现在在做什么」。
    if (event.type === "tool_call" || event.type === "tool_call_update") {
      // formatStatusStreamToolProgress 会挑 command/path/prompt 等字段拼出可读摘要；
      // 返回 null 表示没有任何可展示信息，此时保留上一条进度而不是写入空串。
      const text = formatStatusStreamToolProgress(event);
      if (text) {
        // 写入后不再截断：格式化结果来自有限字段，单条工具摘要远小于文本流。
        liveStatusProgressByTaskId.set(event.taskId, { kind: "tool", text });
      }
    }
  }

  // 职责：把任务列表层的「发生了什么」广播给 UI（新建/更新/删除等），供侧栏刷新。
  // [权衡] fire-and-forget + 吞错：广播断开或订阅方处理失败不能反过来让任务失败；
  // 代价是 UI 可能短时不一致，靠下一次事件或轮询自愈。
  async function broadcastTaskListChange(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
    event: BotTaskBroadcastPayload["event"],
    // extras 用 Partial + Pick 收窄，避免调用方把不相关字段顺手塞进广播体；
    // 可选字段由调用点决定是否出现，而不是用 undefined 占位。
    extras: Partial<
      Pick<
        BotTaskBroadcastPayload,
        | "task"
        | "provider"
        | "configOptions"
        | "prompt"
        | "permissionRequest"
        | "elicitationRequest"
        | "requestId"
        | "error"
      >
    > = {},
  ): Promise<void> {
    // 可选链 + catch：broadcastService 未注入（测试或无 UI 场景）时整个广播降级为空操作。
    await deps.broadcastService
      ?.send({
        channel: BOT_TASK_BROADCAST_CHANNEL,
        // workspacePath 与 workspaceIdentity 成对出现：taskId 只在本工作区内唯一，
        // 只带 taskId 会让跨工作区的同名任务在 UI 上串台。
        payload: {
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          taskId,
          event,
          // updatedAt 由发送侧生成，供订阅方丢弃乱序到达的旧事件。
          updatedAt: Date.now(),
          // extras 放在固定字段之后：允许补充 task/configOptions 等，但不能覆盖身份与时间。
          ...extras,
        },
      })
      .catch(() => undefined);
  }

  // 职责：把原始流事件镜像给 UI（另一条投影通道）。它不解释语义，
  // 只保证事件原样、带工作区身份、可被丢弃；与 IM 回复管线互不阻塞。
  async function broadcastTaskStreamEvent(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    event: ZCodeStreamEvent,
  ): Promise<void> {
    // payload 直接内嵌 event：镜像通道不做裁剪，UI 的解析规则与 CLI 流保持一致；
    // 带 taskId/updatedAt 是为了在订阅侧排序与去重。
    const payload: BotTaskStreamBroadcastPayload = {
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      taskId: event.taskId,
      event,
      updatedAt: Date.now(),
    };
    // 与列表广播同样的吞错策略：镜像失败不得影响主回复与任务执行（INV-09 的降级原则）。
    await deps.broadcastService
      ?.send({
        channel: BOT_TASK_STREAM_BROADCAST_CHANNEL,
        payload,
      })
      .catch(() => undefined);
  }

  // 职责：把可能过期的 workspaceIdentity（远端 alias）解析成 Host 认可的当前身份。
  // 只在有 identity 且注入了 remoteWorkspaceService 时解析：本地 workspace 没有 alias 概念，
  // 空 identity 走这里只会平白多一次远端调用。
  async function normalizeWorkspaceRef(workspace: BotWorkspaceRef): Promise<BotWorkspaceRef> {
    // resolveWorkspace 是远端服务调用；失败向上抛，由调用方决定是否降级为原值。
    if (!workspace.workspaceIdentity || !deps.remoteWorkspaceService?.resolveWorkspace)
      return workspace;
    const resolved = await deps.remoteWorkspaceService.resolveWorkspace({
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
    });
    // 解析结果与输入完全一致时返回原对象：避免无意义的 key 重算与下游缓存失效。
    if (
      !resolved ||
      (resolved.workspacePath === workspace.workspacePath &&
        resolved.workspaceIdentity === workspace.workspaceIdentity)
    )
      return workspace;
    // 用解析后的 path+identity 重建 ref，让 id 由 createWorkspaceRef 统一生成；
    // identity 格式只允许一处定义，业务层不手写（Workspace Identity 规则）。
    return createWorkspaceRef(resolved.workspacePath, resolved.workspaceIdentity);
  }

  // 职责：把 allowedWorkspaces 中「Host 已证明」的远端 alias 迁移为当前 identity。
  // INV-01：迁移只做同一身份的规范化，绝不能按相同 workspacePath 把本地授权扩成远端授权。
  async function normalizeBotWorkspaceIdentities(bot: BotConfig): Promise<BotConfig> {
    // 只迁移 Host 已证明的远端 alias；未知 key 原样保留，绝不按相同路径扩大授权。
    // 逐项并行解析：每个 key 都要访问远端服务，串行会让启动时的配置加载线性变慢；
    // map 保持顺序，Promise.all 不改变结果顺序。
    const allowedWorkspaces = await Promise.all(
      bot.allowedWorkspaces.map(async (key) => {
        // 非远端 identity（本地路径或未知格式）原样返回：解析失败不等于授权失效。
        const parsed = parseRemoteWorkspaceIdentity(key);
        if (!parsed) return key;
        // 取 normalizeWorkspaceRef 结果的 .id：id 是 identity 的规范形式（identity 优先于 path），
        // 直接拼字符串会与其余代码的 key 口径不一致。
        return (await normalizeWorkspaceRef(createWorkspaceRef(parsed.workspacePath, key))).id;
      // [权衡] 规范化后可能产生重复项，这里不去重：相等性判断统一交给
      // normalizeConfiguredAllowedWorkspaces，避免两处各有一套规则。
      }),
    );
    return { ...bot, allowedWorkspaces };
  }

  // 职责：对外暴露可绑定的工作区列表，数据来自项目目录快照。
  // [权衡] 直接读目录快照而不是持久缓存：菜单只是展示层快照，绑定前会再次校验（见 bindProject）。
  // [失败路径] 参数刻意未使用（_params）：当前实现不按 currentWorkspace 过滤，
  // 调用方传入的当前工作区不会影响结果；若未来依赖该过滤，必须在此实现。
  async function listWorkspaceRefs(
    _params: BotListWorkspaceRefsParams = {},
  ): Promise<BotWorkspaceRef[]> {
    // 每次调用都重读 catalog：目录可能被其他窗口改动，缓存会让菜单展示已删除的项目。
    return workspaceRefsFromCatalog(await readProjectCatalog(deps));
  }

  // 职责：把项目目录快照映射成可展示/可绑定的 workspace ref 列表（纯函数，无副作用）。
  // id 用 projectSelectionId（菜单选择 id），不是 workspace key：两者语义不同，
  // 混用会让「绑定」与「授权匹配」互相污染。
  function workspaceRefsFromCatalog(catalog: ProjectCatalogSnapshot): BotWorkspaceRef[] {
    // directory.hosts 是远端 Host 集合：只有远端项目才需要 workspaceIdentity，
    // 本地项目加 identity 会改变既有 state key，表现为历史会话找不到。
    const foreign = new Set(catalog.directory.hosts.map((host) => host.id));
    return catalog.projects.map((project) => {
      // 主根优先，其次第一个根，都没有则为空串：空串代表项目尚未就绪，
      // 下游必须据此拒绝绑定，而不是拿空路径去开任务。
      const workspacePath =
        project.roots.find((root) => root.isPrimary)?.rootPath ?? project.roots[0]?.rootPath ?? "";
      // rootPaths 全量保留：旧 path-only 授权迁移时需要用它判断同一目录的历史归属。
      return {
        id: projectSelectionId(project),
        label: project.name,
        projectId: project.id,
        hostId: project.hostId,
        workspacePath,
        rootPaths: project.roots.map((root) => root.rootPath),
        // 远端项目附带 buildRemoteHostWorkspaceIdentity(hostId, path)：identity 必须由 Host 生成，
        // 业务侧不手写格式，否则远端解析失败会被当成新工作区（INV-05）。
        ...(foreign.has(project.hostId) && workspacePath
          ? { workspaceIdentity: buildRemoteHostWorkspaceIdentity(project.hostId, workspacePath) }
          : {}),
      };
    });
  }

  // 职责：把一次菜单点击（workspace.id）兑现成真实的项目会话绑定。
  // 三段式：before 快照 → prepareSession（有副作用）→ after 快照，任一步发现目录变化就中止。
  // 为什么不能只信菜单：菜单是展示快照，用户可能已删除项目或重新加入 Host；
  // 迟到点击必须失效，否则会把旧 owner 的 prepare 结果保存成新绑定。
  // 维护 INV-01 与 Workspace Identity 规则（同一 Host 内项目唯一）。
  async function bindProject(
    workspace: BotWorkspaceRef,
  ): Promise<
    Pick<
      BotContextState,
      | "projectId"
      | "hostId"
      | "workspacePath"
      | "workspaceIdentity"
      | "workspaceId"
      | "additionalDirectories"
    >
  > {
    // 菜单只是展示快照。重新读取仍保留的项目，再由 owner 解析，迟到点击不能复活入口。
    // prepareSession 之前在锁外读一次目录：拿到「用户点击时看到的那个项目」的身份。
    const before = await readProjectCatalog(deps);
    // 按菜单 id 找回当前项目；找不到说明快照已过期。
    const current = workspaceRefsFromCatalog(before).find((item) => item.id === workspace.id);
    // [失败路径] 抛错而不是回落：绑定动作没有安全的默认值，错误由上层转成用户可见提示。
    if (!current?.projectId || !current.hostId)
      throw new Error("Bot project is no longer available");
    // 副作用点：prepareSession 会创建/附加 Host 会话，可能落盘或走远端。
    // 因此后面必须再读一次目录，确认这次副作用对应的项目仍然存在。
    const execution = await deps.projectService.prepareSession({
      projectId: current.projectId,
      hostId: current.hostId,
    });
    // after 快照用于检测「prepare 期间目录被改」的窗口。
    const after = await readProjectCatalog(deps);
    // 取 before 中的 host 记录，用 membershipId 判断是否被移除后重新加入。
    const host = before.directory.hosts.find((item) => item.id === current.hostId);
    // retainedEntries 记录本项目相关的目录条目（含 legacy workspace 映射），
    // 用来证明 prepare 期间没有条目被删除：项目能被重新添加，但旧条目 id 已变。
    const retainedEntries = before.directory.entries.filter(
      (entry) =>
        entry.hostId === current.hostId &&
        (entry.projectId === current.projectId ||
          (entry.projectId === null &&
            entry.legacyWorkspace &&
            current.rootPaths?.includes(entry.legacyWorkspace.workspacePath))),
    );
    // 同一 ID 移除再添加也是新 admission；不能将旧 owner 的 prepare 结果保存为新绑定。
    // 两个条件任一成立就中止：
    // 1) after 里已找不到同一菜单 id 的项目（项目被移除，或 id 已重新生成）；
    // 2) Host 仍在但 membershipId 变了，或任一相关目录条目消失（等同重新加入或迁移）。
    if (
      !workspaceRefsFromCatalog(after).some((item) => item.id === current.id) ||
      (host &&
        (!after.directory.hosts.some(
          (item) => item.id === host.id && item.membershipId === host.membershipId,
        ) ||
          // 逐条核对 retainedEntries：只比 host 不够，项目条目本身可能被单独移除再添加。
          !retainedEntries.some((entry) =>
            after.directory.entries.some((item) => item.id === entry.id),
          )))
    )
      throw new Error("Bot project was removed during binding");
    // hostId/workspaceId 用 current 覆盖 execution 的返回值：执行结果可能来自
    // prepareSession 的默认推断，而绑定事实必须锚定在用户点击的那条目录项上。
    return { ...execution, hostId: current.hostId, workspaceId: current.id };
  }

  // 职责：把缺少 projectId/hostId 的旧 context 从当前目录快照上升级出完整身份（纯函数）。
  // 旧状态的 canonical key 是执行身份（workspaceIdentity 或 path），不是 Host 归属，
  // 因此不能直接当 hostId 用；这里逐级回退，并且只在证据唯一时才绑定项目。
  function upgradeLegacyContext(
    context: BotContextState,
    catalog: ProjectCatalogSnapshot,
  ): BotContextState {
    // 先算出全部候选 workspace，后续按 path 与 identity 交叉匹配。
    const workspaces = workspaceRefsFromCatalog(catalog);
    const identity = context.workspaceIdentity;
    // 历史 canonical key 是执行身份，不能直接当作新 Source 的持库 host ID。
    // 旧目录条目记录的 legacyWorkspace identity+path 是「这条 key 属于哪个 Host」的唯一历史证据；
    // 优先用它，避免把远端工作区误判成本地。
    const legacyHostId = catalog.directory.entries.find(
      (entry) =>
        entry.legacyWorkspace?.workspaceIdentity === identity &&
        entry.legacyWorkspace?.workspacePath === context.workspacePath,
    )?.hostId;
    // 回退顺序：历史条目 → 从 identity 解析 → 当前 owner host → 本地。
    // identity 解析失败不能报错，旧状态必须仍然可被打开。
    const hostId = identity
      ? (legacyHostId ?? remoteHostIdFromWorkspaceIdentity(identity))
      : (deps.ownerHostId ?? "local");
    // 有 identity 时要求 host 或 identity 任一匹配：旧 identity 可能编码的是已改名的 host alias。
    // 无 identity 时只接受本地 workspace（!workspace.workspaceIdentity），
    // 防止 path-only 旧状态平白获得远端授权（INV-01）。
    const candidates = workspaces.filter(
      (workspace) =>
        workspace.rootPaths?.includes(context.workspacePath) &&
        (identity
          ? workspace.hostId === hostId || workspace.workspaceIdentity === identity
          : !workspace.workspaceIdentity),
    );
    // 旧 path-only 远端只在唯一候选时补身份；已有 cwd 永远不跟随项目主要目录。
    // 仅当「没有 identity 且按 host 过滤后为空」时才放宽为纯路径候选：
    // 这是旧版本的唯一形态，后面还会做唯一性校验。
    const legacyRemote =
      !identity && candidates.length === 0
        ? workspaces.filter((workspace) => workspace.rootPaths?.includes(context.workspacePath))
        : [];
    // [权衡] 只有唯一候选才绑定；多候选时宁可保持未绑定（projectId=null）。
    // 同一 cwd 挂多个项目很常见，随便选一个会把任务写进错误项目，用户几乎无法发现。
    const selected =
      candidates.length === 1
        ? candidates[0]
        : legacyRemote.length === 1
          ? legacyRemote[0]
          : undefined;
    // hostId 的最终兜底顺序与上面一致，保证任何旧状态都能落到一个确定的 host。
    const resolvedHostId = selected?.hostId ?? hostId ?? deps.ownerHostId ?? "local";
    // 仅在选中项确有远端身份时才补 identity：本地项目补 identity 会让 state key 变化，
    // 表现为「升级后历史任务全丢」。
    const workspaceIdentity =
      identity ??
      (selected?.workspaceIdentity && selected.hostId
        ? buildRemoteHostWorkspaceIdentity(selected.hostId, context.workspacePath)
        : undefined);
    // 字段整体重写而不是局部 merge：projectId=null 必须显式写入
    // （类型注释约定：明确 NULL 表示不再按目录归类）。
    return {
      ...context,
      projectId: selected?.projectId ?? null,
      hostId: resolvedHostId,
      workspaceIdentity,
      workspaceId:
        selected?.id ??
        context.workspaceId ??
        getWorkspaceKey(context.workspacePath, workspaceIdentity),
      // [权衡] 清空额外目录：旧状态里的 addDirs 无法用新项目模型验证，保留等于绕过项目边界。
      additionalDirectories: [],
    };
  }

  // 职责：把 bot 的 allowedWorkspaces 对齐到当前目录快照，并在变化时写回配置。
  // 返回四个视图：新配置、新 bot、user 副本、当前工作区列表。
  // 副作用：可能调用 writeBotConfig（进而使话题/绑定失效），因此只在真的变化时写。
  // 维护 INV-01：只做规范化与唯一候选交接，绝不扩大授权集合。
  async function normalizeBotWorkspaceConfig(
    config: BotsConfigFile,
    bot: BotConfig,
    currentWorkspace?: BotWorkspaceRef,
  ): Promise<{
    config: BotsConfigFile;
    bot: BotConfig;
    user: BotConfig;
    workspaces: BotWorkspaceRef[];
  }> {
    // 工作区列表来自目录快照；currentWorkspace 参数目前不参与过滤（见 listWorkspaceRefs）。
    const workspaces = await listWorkspaceRefs({ currentWorkspace });
    // 先迁移远端 alias（Host 已证明），再交给通用规范化做去重与 ALL 处理。
    const nextAllowedWorkspaces = normalizeConfiguredAllowedWorkspaces(
      (await normalizeBotWorkspaceIdentities(bot)).allowedWorkspaces,
      workspaces,
    );
    // nextBot 保留原对象其余字段，只替换 allowedWorkspaces。
    const nextBot: BotConfig = {
      ...bot,
      // 旧路径授权只在项目候选唯一时交接；同 cwd 多项目不能扩大权限。
      allowedWorkspaces: nextAllowedWorkspaces,
    };
    // 配置整体重建：只替换当前 bot 条目，其他 bot 原样带过去，避免间接覆盖用户改动。
    const nextConfig: BotsConfigFile = {
      ...config,
      bots: config.bots.map((item) => (item.id === bot.id ? nextBot : item)),
    };
    // [事务] 用 join("\n") 比较而不是数组引用或长度：数组每次都是新对象，引用必不相等。
    // 比较对顺序敏感，但 allowedWorkspaces 由上面的规范化流程生成，顺序稳定。
    const shouldWrite = nextBot.allowedWorkspaces.join("\n") !== bot.allowedWorkspaces.join("\n");
    // [权衡] 仅变化时写盘：写配置带文件锁且会触发绑定失效逻辑，
    // 每次启动都写会让话题和既有绑定被无谓作废。
    if (shouldWrite) {
      await writeBotConfig(nextConfig);
    }
    // user 与 bot 指向同一对象：调用方把它当「该 bot 作为用户的操作视图」使用；
    // 若二者需要分叉，必须在返回前复制，不能在这里隐式 clone（会让 id 比较失效）。
    return { config: nextConfig, bot: nextBot, user: nextBot, workspaces };
  }

  // 职责：从任务列表里取某个 taskId 的 meta；找不到返回 null（不抛错）。
  // 只读，但代价是整表列举：适合做轻量存在性检查，需要完整快照时再走 getTaskSnapshot。
  async function readTaskMeta(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
  ): Promise<ZCodeTaskMeta | null> {
    // 按 context 解析 task service：本地与远端 Host 是不同实现，不能做成全局单例。
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    // listTasks 按 workspacePath + workspaceIdentity 双条件过滤：只传 path 会把同路径的
    // 远端任务混进来（Workspace Identity 规则）。
    const tasks = await zcodeTaskService.listTasks({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    // find 而不是按索引取值：列表顺序由 Host 决定，调用方不应依赖位置。
    return tasks.find((task) => task.taskId === taskId) ?? null;
  }

  // 职责：构造「当前上下文可选任务」菜单项（task.set 选择器使用）。
  // 三层过滤：工作区授权 → 项目 + workspace key → 群内已登记任务。
  // 纯读：读 project tree，不写状态、不发消息。
  async function listContextTaskSelectionEntries(
    context: BotContextState,
    user: BotConfig,
  ): Promise<BotTaskSelectionEntry[]> {
    // INV-01：workspaceId 不在 allowedWorkspaces 时直接返回空，菜单本身也不能泄露未授权
    // 工作区的任务。注意条件里的 context.workspaceId：旧状态没有该字段时会跳过这道检查。
    if (context.workspaceId && !isWorkspaceAllowed(context.workspaceId, user.allowedWorkspaces))
      return [];
    // readTree 按 hostId 读取：任务树属于 Host，不是全局视图。
    const tree = await deps.projectService.readTree({ hostId: context.hostId });
    // key 与全库统一口径一致（identity 优先、path 兜底），否则同目录不同 identity 会被并到一起。
    const key = getWorkspaceKey(context.workspacePath, context.workspaceIdentity);
    // 项目 + workspace key 双重匹配：projectId 单独不足以区分同一项目在多个 Host 的副本。
    return tree.tasks
      .filter(
        (task) =>
          task.projectId === (context.projectId ?? null) &&
          getWorkspaceKey(task.workspacePath, task.workspaceIdentity) === key,
      )
      // 群会话只暴露 group.taskIds 内的任务：群里发起的任务才属于群上下文；
      // 不加这道过滤会把 owner 的私聊任务列进群菜单（越权可见）。
      .filter((task) => !context.group || context.group.taskIds.includes(task.taskId))
      .map((task) => ({
        task,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      }));
  }

  // 职责：把用户输入解析成待选任务条目；先按原值直查（按钮/稳定 id），
  // 再按选择器选项解析（序号、旧编号）。两者都失败返回 null。
  // [并发] 菜单存于 per-actor Map：不同用户的选择互不可见，避免群成员用序号选中别人的任务。
  function resolvePendingTaskSelectionEntry(
    actor: BotActor,
    value: string,
  ): BotTaskSelectionEntry | null {
    // getActorContextKey 含 providerUserId（群场景），是「按人」而不是「按会话」的键。
    const actorContextKey = getActorContextKey(actor);
    // 直查用 trim 后的原值：按钮回传的是稳定 option id，必须原样命中（INV-11）。
    const directEntry = pendingTaskSelectionsByContext.get(actorContextKey)?.get(value.trim());
    if (directEntry) {
      return directEntry;
    }
    // 兼容序号/文本输入：resolvePendingSelectionOption 按当前菜单快照解析，返回的 id 再回查条目。
    const option = resolvePendingSelectionOption(actor, "task.set", value);
    if (!option) {
      return null;
    }
    return pendingTaskSelectionsByContext.get(actorContextKey)?.get(option.id) ?? null;
  }

  // 与 task 版本同构：先直查 option id，再按 workspace.set 菜单解析。
  // 不泛型化合并：两类条目类型与菜单命名空间不同，合并只会引入运行时类型判断。
  function resolvePendingWorkspaceSelectionEntry(
    actor: BotActor,
    value: string,
  ): BotWorkspaceSelectionEntry | null {
    // actorContextKey 每次现算而不是缓存：群 key 含发送者维度，换人或换话题必须取到不同菜单。
    const actorContextKey = getActorContextKey(actor);
    const directEntry = pendingWorkspaceSelectionsByContext.get(actorContextKey)?.get(value.trim());
    if (directEntry) {
      return directEntry;
    }
    // 解析失败返回 null，由调用方提示「选择已失效」；不在这里兜底成默认工作区（INV-01）。
    const option = resolvePendingSelectionOption(actor, "workspace.set", value);
    if (!option) {
      return null;
    }
    return pendingWorkspaceSelectionsByContext.get(actorContextKey)?.get(option.id) ?? null;
  }

  // 职责：从持久化 context 反向构造 workspace ref，供「当前工作区」展示与授权比较。
  // 无副作用；字段必须与 workspaceRefsFromCatalog 同名口径一致，否则 id 无法与菜单项对齐。
  function createCurrentWorkspaceRef(context: BotContextState): BotWorkspaceRef {
    return {
      // 先铺开 createWorkspaceRef 的结果（path/label/rootPaths），再覆盖 id/projectId/hostId。
      ...createWorkspaceRef(context.workspacePath, context.workspaceIdentity),
      // id 优先用持久化的 workspaceId：它是绑定当时写入的值，重算可能因目录变化而漂移。
      id: context.workspaceId ?? getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      projectId: context.projectId ?? undefined,
      hostId: context.hostId,
    };
  }

  // 职责：取当前 active task 的 meta，两级回退：先 listTasks，再 getTaskSnapshot。
  // 为什么要回退：listTasks 依赖 Host 的任务索引，索引未及时更新时查不到刚创建的任务；
  // 直接返回 null 会让 /status 与命令误报「无活动任务」。
  async function readContextActiveTaskMeta(
    context: BotContextState,
  ): Promise<ZCodeTaskMeta | null> {
    // 无 activeTaskId 是正常草稿态，不查任何服务。
    if (!context.activeTaskId) {
      return null;
    }
    // 第一级失败被 catch 成 null：索引不可用不应阻断第二级快照查询。
    const listedTask = await readTaskMeta(context, context.activeTaskId).catch(() => null);
    // 列表命中即返回，避免每次 /status 都去读整份 session 快照。
    if (listedTask) {
      return listedTask;
    }
    // [失败路径] 快照也失败时返回 null，上层统一转成 noActiveTask 文案：
    // 这会把后端故障伪装成「没有任务」，是已知的语义损失（仅标注，未修改）。
    return (
      (
        await (
          await resolveZCodeTaskServiceForContext(context)
        )
          .getTaskSnapshot({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          .catch(() => null)
      )?.meta ?? null
    );
  }

  // 职责：需要活动任务的命令入口守卫。成功返回 taskId + meta + configOptions，
  // 失败返回可直接发送的回复数组（而不是抛错），让各命令保持统一返回类型。
  // 副作用：读任务列表/快照、读配置选项（可能访问远端 Host）。
  async function requireActiveTask(
    message: BotInboundMessage,
    auth: {
      context: BotContextState;
      locale: Locale | undefined;
    },
  ): Promise<
    | {
        ok: true;
        taskId: string;
        task: ZCodeTaskMeta;
        configOptions: ZCodeConfigOption[];
      }
    | { ok: false; reply: BotOutboundMessage[] }
  > {
    // 两个失败分支给出同一文案：对用户而言「没有任务」与「任务已不存在」都意味着先发一句话创建任务。
    if (!auth.context.activeTaskId) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))],
      };
    }
    // meta 缺失不再尝试恢复：任务可能已被外部删除，继续拿着 activeTaskId 操作只会产生连锁错误。
    const task = await readContextActiveTaskMeta(auth.context);
    if (!task) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))],
      };
    }
    // configOptions 在这里读取而不是交给调用方：保证返回的 task 与选项来自同一时刻的上下文。
    const configOptions = await listActiveTaskConfigOptions(
      auth.context,
      auth.context.activeTaskId,
    );
    // taskId 取 context.activeTaskId 而不是 task.taskId：前者是本次鉴权所依据的值，
    // 避免 meta 返回错位任务时把命令发到别的任务。
    return {
      ok: true,
      taskId: auth.context.activeTaskId,
      task,
      configOptions,
    };
  }

  // 职责：任务配置（模型/模式等）变化后广播一次 updated，让 UI 刷新选项与当前值。
  // 只广播变化字段：未传的字段不出现在 payload 里，订阅方据此区分「未变化」与「被清空」。
  async function broadcastTaskConfigSync(params: {
    context: BotContextState;
    taskId: string;
    task?: ZCodeTaskMeta | null;
    provider?: ZCodeProvider;
    configOptions?: ZCodeConfigOption[];
  }): Promise<void> {
    // 条件展开而不是 task: params.task：undefined/null 会被当成显式清空或被 schema 拒绝，
    // 因此只有确实提供时才带上该键。
    await broadcastTaskListChange(params.context, params.taskId, "updated", {
      ...(params.task ? { task: params.task } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.configOptions ? { configOptions: params.configOptions } : {}),
    });
  }

  function isTerminalTaskMeta(
    task: ZCodeTaskMeta | null,
    eventType: "task_complete" | "task_error",
  ): boolean {
// 判定「事件声明的终态」与「任务索引里的 meta」是否已经对齐：
// 只有 eventType 与 task.status 属于同一语义对时，才能安全地按终态渲染摘要/错误。
// [失败路径] null 表示索引里还没有这条任务（可能刚创建、可能已被清理），
// 不能当成“终态已稳定”，否则调用方会跳过重试并广播空 task，UI 侧栏停在旧状态。
    if (!task) {
      return false;
    }
    if (eventType === "task_error") {
      return task.status === "error";
// task_error 只认 status === "error"：若放宽成“任意非 running”，用户主动停止产生的
// cancelled/stopped 会被当成异常失败，回复带出错误摘要并污染失败计数。
    }
    return task.status === "completed";
  }
// task_complete 只认 completed：任务被取消后即便迟到的 complete 事件到达，
// 也不能把 cancelled 覆盖成完成，否则结果投递与卡片终态会同时存在两种事实。

// 在终态事件到达后读取“尽量稳定”的 task meta，供侧栏/结果回复使用。
// 输入是事件里的 taskId 而不是 activeTaskId：群话题里事件可能属于被切换掉的旧任务。
// 副作用只有若干次 listTasks 读；失败语义是“返回仍可能是非终态的 meta”，由调用方容忍。
// 维护 INV-07：终态事件不得因为 meta 未落盘而丢失。
// [时序] Agent 先广播终态事件、后写 task index/meta；二者之间有一个很短的窗口。
// 不等待就会先按 running 摘要增量更新，随后再刷成终态，用户看到状态与摘要“跳一下”。
  async function readTerminalTaskMeta(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
    eventType: "task_complete" | "task_error",
  ): Promise<ZCodeTaskMeta | null> {
// 首读失败降级为 null 而不是向上抛：读不到 meta 属于可重试情形，
// 若在这里抛出，整个任务事件处理会中断，监听器里的清理（pending elicitation、订阅）都不会执行。
    let latestTask = await readTaskMeta(context, taskId).catch(() => null);
// 命中即返回，避免无谓的重试延迟；这是最常见的路径（事件落后于写盘）。
// 返回值是 latestTask 本身而非布尔，调用方直接消费 status/changeSummary，避免二次读盘。
    if (isTerminalTaskMeta(latestTask, eventType)) {
      return latestTask;
    }

// [权衡] 重试窗口取 80/160/320ms（BOT_TASK_META_RETRY_DELAYS_MS）：总计不到 0.6s，
// 足以覆盖一次写盘+索引刷新的抖动，又不会在 task 事件循环里长时间挂着。
// 反过来若改成“固定间隔轮询到超时”，每个终态事件都会阻塞后续事件最多数秒，群消息顺序被打乱。
    for (const retryDelayMs of BOT_TASK_META_RETRY_DELAYS_MS) {
      await delay(retryDelayMs);
// 重试读失败时保留上一次结果：读接口失败与“任务不存在”都会得到空值，
// 若直接覆盖成 null，会把先前已经读到的 running meta 也丢掉，最终连旧状态都无法广播。
      latestTask = await readTaskMeta(context, taskId).catch(() => latestTask);
// 每轮都重新判定，不能只在循环结束后判一次：meta 可能在任意一轮收敛，越早返回越快解除阻塞。
      if (isTerminalTaskMeta(latestTask, eventType)) {
        return latestTask;
      }
    }

// 三轮都没等到终态时仍返回最后一次读到的值（可能是 null）。
// [失败路径] 这里刻意不抛错：宁可广播一次过期状态，也不能让终态事件被丢弃，
// 否则群任务结果的最终投递（INV-07）和侧栏完成态都会永久缺失。
    return latestTask;
  }

// 所有平台回调（飞书卡片按钮、Telegram callback_query、微信消息）的统一入口。
// 输入是已经过 transport 解析的 provider 与原始 payload；输出 BotProviderCallbackResult，
// 由上层转成 HTTP 响应（status/responseBody）或待发送回复（replies）。
// [资源] 这里会读取凭据、读配置/状态、下载引用附件、写群状态；全部按顺序串行，无并发保护，
// 依赖 transport 对同一 bot 的回调串行投递（群内多人并发点击时由 enqueueInboundProcessing 兜底）。
  async function processProviderCallback(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult> {
// adapter 由 provider 名决定。取不到说明该 provider 未注册（配置残留或版本不匹配）。
    const adapter = providers[provider];
// [失败路径] 返回 400 而不是抛错：未注册 provider 无论如何重试都不会成功，
// 抛错会经 transport 变成 5xx，诱发平台反复重投同一事件。
    if (!adapter) {
      return { ok: false, replies: [], status: 400 };
    }
// locale 只用于错误文案，必须在任何授权判定之前就绪；
// 它不影响下面的 401/403 决策，因此不构成“用客户端输入提升权限”的风险（INV-01）。
    const locale = await readMessageLocale();
// 每次都重新读配置：回调可能指向刚被禁用/改绑的 bot，缓存旧配置会让失效 bot 继续执行命令。
    const config = await repo.readConfig();
// 回调归属的 bot 完全由 payload.botId 决定（无 botId 时回退到同 provider 首个启用 bot，
// 兼容未注入 botId 的旧 webhook）。由此得到的 callbackBot 只用于“选哪个适配器/凭据”，
// 不用于判定操作者权限：真正的群授权仍要看 BotGroupSource 与持久状态。
    const callbackBot = findCallbackBot(config, provider, payload);
    // 在读取引用附件和处理退群事件之前验证回调，避免未验证事件产生读写副作用。
// 只对配置了 webhookSecretRef 的飞书 bot 做共享密钥校验；
// 未配置表示部署方选择了“不校验入站 token”（例如仅走长连接），此时不能凭空拒绝。
    if (callbackBot && isFeishuBotProvider(provider) && callbackBot.webhookSecretRef) {
// 凭据读取是异步 IO，放在校验最前面，保证任何写状态/下载附件之前就能失败退出。
      const expectedToken = await deps.credentialService.load(callbackBot.webhookSecretRef);
// header 既可能承载签名也可能承载 token；用 isRecord 收窄，避免对任意 JSON 取值抛 TypeError。
      const header = isRecord(payload) && isRecord(payload.header) ? payload.header : null;
// token 有两条来源：顶层 token（旧版 webhook）与 header.token（飞书 v2 事件封装）。
// 先顶层后 header，保持与平台实际投递格式一致，二者都存在时以顶层为准。
      const inboundToken = isRecord(payload)
        ? (readNestedString(payload, "token") ?? readNestedString(header, "token"))
        : undefined;
// [失败路径] expectedToken 为空也要拒绝：配置了 ref 却读不到凭据，说明凭据丢失或解密失败，
// 此时放行等于把“无签名”当成合法。返回 401 且带本地化错误，便于平台侧定位配置问题。
      if (!expectedToken || expectedToken !== inboundToken) {
        return {
          ok: false,
          replies: [],
          status: 401,
          responseBody: { error: msg(locale, "webhookSecretInvalid") },
        };
      }
    }
// materialPayload 是“只读事实增强”后的 payload：不改变鉴权结论，只补充服务端已知状态。
    let materialPayload = payload;
// 仅飞书需要补 zcodeTopicHasAcceptedInput：feishuProvider 用它判断根消息是否已被接收过，
// 从而决定要不要把父消息当作引用附件再次下载。其它 provider 的 payload 保持原样。
    if (callbackBot && isFeishuBotProvider(provider) && isRecord(payload)) {
// 事件体可能包在 event 字段里，也可能是事件本身；两种形状都要兼容。
// native 取 event.message（消息事件），缺失时用空对象，后续 readNestedString 全部返回 undefined。
      const event = isRecord(payload.event) ? payload.event : payload;
      const native = isRecord(event.message) ? event.message : {};
// chat_id 与 thread_id 必须同时存在才能定位话题：
// 只有 chatId 时那是群会话级状态，与话题输入（topic inputs）不是同一份数据。
      const chatId = readNestedString(native, "chat_id");
      const threadId = readNestedString(native, "thread_id");
// [并发] 这里只做一次 readState 快照，不持有跨 await 的“读-改-写”；
// 后续若要写状态必须重新读取并经 serializeStateWrite（INV-02），不能用这份快照覆盖。
      const topic =
        chatId && threadId
          ? (await repo.readState()).bots[
              getBotConversationKey({ botId: callbackBot.id, chatType: "group", chatId, threadId })
            ]
          : undefined;
// 根引用只在“该话题此前没有 accepted 输入”时才算首次材料；一旦存在 accepted 输入，
// 同一根消息就不该被重复识别为引用附件，否则退出再接入会把旧根消息重新下载一遍。
      // 根引用属于首次输入，不属于 active 状态；退出再接入不能重复读取它。
// 判定只来自 BotsRepo 里的 inputs.admission，绝不读 payload 里的同名字段：
// 回调 payload 由平台/客户端提供，可被伪造成“已接收”来跳过首次材料准备（INV-01）。
      // 只信服务记录，外部回调不能声称已接收来跳过首次材料准备。
// 用展开复制而不是原地改 payload：调用方可能复用该对象，原地写入会把服务端事实泄漏到上层缓存。
      materialPayload = {
        ...payload,
        zcodeTopicHasAcceptedInput: Object.values(topic?.group?.inputs ?? {}).some(
          (input) => input.admission === "accepted",
        ),
      };
    }
// 适配器可以在这里做解密、下载引用附件、把平台事件归一化成内部消息。
// [资源] 该步骤可能有网络请求与落盘，因此必须在校验通过之后、解析之前执行一次，不能重试放大。
    const preparedPayload = callbackBot
      ? ((await adapter
// 适配器失败被收敛成带 zcodeCallbackPrepareError 的对象，而不是让异常冒泡：
// 统一走同一个失败出口，保证返回值结构（ok/replies/status）恒定，transport 不必区分异常类型。
          .prepareCallbackPayload?.(callbackBot, materialPayload)
// [失败路径] 错误文本只取 message，不搬运 stack/底层 payload，
// 避免把凭据或附件 URL 写进 HTTP 响应与日志。
          .catch((error: unknown) => ({
            zcodeCallbackPrepareError: error instanceof Error ? error.message : String(error),
// 适配器未实现 prepareCallbackPayload 时回落到原 payload：
// 该钩子是可选的，缺失不代表失败；用 ?? 而不是提前 return 保持单一路径。
          }))) ?? payload)
      : payload;
// 收敛后的失败对象可能是任意形状（适配器返回了非 record），因此先 isRecord 收窄再取字段。
    if (
      isRecord(preparedPayload) &&
      typeof preparedPayload.zcodeCallbackPrepareError === "string"
    ) {
// 用 401 而不是 5xx：prepare 失败是“这条回调无法被安全处理”，让平台看到未处理即可；
// 5xx 会触发平台重投，同一张卡片可能被下载/解密多次，产生重复附件与重复副作用。
      return {
        ok: false,
        replies: [],
        responseBody: { error: preparedPayload.zcodeCallbackPrepareError },
        status: 401,
      };
    }
// 适配器主动生成响应体（例如飞书 url_verification、卡片同步响应）时，
// 业务层不再解析消息，直接把它交给 transport，避免同一次回调被当成用户消息二次处理。
    const callbackResponse = callbackBot
// 该钩子同样可选；没有实现时 handleCallbackResponse 为 undefined，可选链直接得到 null。
      ? await adapter.handleCallbackResponse?.(callbackBot, preparedPayload)
      : null;
// 用 responseBody !== undefined 判断“适配器接管”，而不是看 status：
// status 可能为 undefined（默认 200），只按 status 判断会把接管响应误当普通回调继续解析。
    if (callbackResponse?.responseBody !== undefined) {
      return {
// ok 由 HTTP 语义推导（<400 视为成功），保证 transport 只依赖一个布尔位。
        ok: (callbackResponse.status ?? 200) < 400,
        replies: [],
        responseBody: callbackResponse.responseBody,
        status: callbackResponse.status,
      };
    }
// 机器人被移出群：这一事件必须先于消息解析处理，因为它改变的是群授权与在飞输入，而不是一条用户消息。
// 条件三重收窄（callbackBot + 飞书 + 明确标记）防止把普通消息里同名字段当成退群事件（INV-01）。
    if (
      callbackBot &&
      isFeishuBotProvider(provider) &&
      isRecord(preparedPayload) &&
      preparedPayload.zcodeBotRemoved === true
    ) {
// 退群事件的 chat_id 既可能在 event 内也可能在顶层；readNestedString 已处理 null。
      const event = isRecord(preparedPayload.event) ? preparedPayload.event : preparedPayload;
      const chatId = readNestedString(event, "chat_id");
// 没有 chatId 就什么都不能做：退群必须精确到具体群，不能“猜”当前会话。
      if (chatId) {
// 读持久状态而不是内存投影：退群可能发生在服务刚启动、上下文尚未加载时（INV-02）。
        const state = (await repo.readState()).bots[
          getBotConversationKey({ botId: callbackBot.id, chatType: "group", chatId })
        ];
// 只有存在 group 状态才需要收尾；私聊上下文没有群授权可撤销。
        if (state?.group) {
// [事务] 先禁用群并轮换 authorizationId，再取消在飞输入：authorizationId 变更会让
// 已排队的群投递（authorized 里比对 authorizationId）全部被判为过期，阻止退群后继续发结果。
// 若顺序反过来，取消过程中仍可能有一条投递通过旧 authorizationId 校验，泄漏到已退出的群。
          await writeContext(
            { ...state, group: { ...state.group, enabled: false, authorizationId: randomUUID() } },
// 第二参数 true 表示“允许本次写入更新授权关联”。这里正要轮换 authorizationId，
// 必须显式放行；走默认的保守路径时，持久层发现 authorizationId 与本次上下文不一致就会
// 直接丢弃写入，并发的第二次退群会把这次停用写丢，群仍保持启用。
            true,
          );
// 以群主身份取消该群所有未完成的话题输入：ownerId 来自持久状态，不是回调里的 sender（INV-01）。
          await cancelGroupTopicInputs({
            botId: callbackBot.id,
            provider: callbackBot.provider,
            chatType: "group",
            chatId,
            providerUserId: state.group.ownerId,
          });
        }
      }
// 退群事件不需要任何回复，但必须报告 ok:true，否则平台会不断重投该事件。
      return { ok: true, replies: [] };
    }
// 飞书没有在 payload 里携带“这是群还是单聊”的稳定字段，注入 provider 让 parseCallback
// 能按飞书/lark 的差异解析；注入值覆盖 payload 同名字段，避免客户端伪造 zcodeProvider。
    let parsePayload =
      isFeishuBotProvider(provider) && isRecord(preparedPayload)
        ? { ...preparedPayload, zcodeProvider: provider }
        : preparedPayload;
    if (callbackBot && isFeishuBotProvider(provider) && isRecord(parsePayload)) {
      const event = isRecord(parsePayload.event) ? parsePayload.event : parsePayload;
// 卡片回调把会话信息放在 event.context，且字段名在群/单聊间不一致（open_chat_id / chat_id）。
      const cardContext = isRecord(event.context) ? event.context : null;
// 先 open_chat_id 再 chat_id：前者是卡片上下文里的群 id，后者是兜底字段。
      const cardChatId =
        readNestedString(cardContext, "open_chat_id") ?? readNestedString(cardContext, "chat_id");
// 只有“服务端记录里确实存在这个群”时才标记为群：否则伪造的 open_chat_id
// 可以把单聊回调提升成群语义，进而获得群授权分支（INV-01）。
      if (cardChatId) {
        const states = await repo.readState();
        const group =
          states.bots[
            getBotConversationKey({ botId: callbackBot.id, chatType: "group", chatId: cardChatId })
          ];
// 标记只影响解析口径（mention 规则、话题路由），不参与授权判定；
// 真正的群授权仍由 findAuthorizedBot 与 BotGroupSource 决定。
        if (group?.group) parsePayload = { ...parsePayload, zcodeChatType: "group" };
      }
    }
// parseCallback 是纯函数式解析：不读盘、不发网络。返回 0 条是合法结果
// （飞书 reaction/已删除事件、未知卡片动作），因此下面只记 debug 日志、不报错。
    const parsedInboundMessages = adapter.parseCallback(parsePayload);
// 只在飞书分支打这条日志，而且用摘要而不是正文：飞书长连接最常见的故障是
// “订阅没有推到本机”，需要靠 payload 形状与解析条数定位；
// 但群消息正文属于用户内容，不能整段落进 debug 日志。
    if (isFeishuBotProvider(provider)) {
      // Bugfix: 飞书 WebSocket connected 只代表长连接已建成，不代表事件订阅已经推到本机。
      // 这里记录入口 payload 摘要和解析数量，方便区分“飞书未推事件”和“payload 形状未被解析”。
// debug 级：回调与消息同量级高频，不能进 info/warn，否则生产日志随流量膨胀。
      botsLogger.debug(
        undefined,
        `provider callback parsed provider=${provider} count=${parsedInboundMessages.length} ${summarizeCallbackPayload(preparedPayload)}`,
      );
    }
// replies 只装“需要由 transport 回给平台”的消息；feishuChannelRuntime 只消费 replies[0]，
// 因此后续凡是必须送达的多条消息都要显式 sendOutbound，不能只 push 进 replies。
    const replies: BotOutboundMessage[] = [];
// 用独立布尔累计业务失败：一个 payload 可能解析出多条消息，只要有一条失败，
// 整次回调就必须报告 ok:false，阻止平台提交外部游标（否则失败的那条被永久跳过）。
    let hadBusinessFailure = false;
// 入站密文只从 preparedPayload.webhookSecret 取（适配器从 header/query 提取），
// 不从消息正文/事件文本推断，避免正文伪造密文通过校验（INV-01）。
    const inboundSecret =
      isRecord(preparedPayload) && typeof preparedPayload.webhookSecret === "string"
        ? preparedPayload.webhookSecret
        : undefined;
// [并发] 同一 payload 的多条消息按顺序串行处理，不并发：它们可能属于同一话题，
// 并发会绕过 enqueueInboundProcessing 的 actor 串行假设，产生重复任务或乱序回复。
    for (const inbound of parsedInboundMessages) {
// 每条 inbound 单独按 botId 重新查配置：一个 webhook 可能承载多个 bot 的事件，
// 复用 callbackBot 会把 A bot 的消息记到 B bot 的上下文。
      const bot = findBot(config, inbound.botId);
// webhook（自建渠道）用共享 secret 校验；与飞书 token 分开判断，因为两者来源字段不同。
      if (bot?.provider === "webhook" && bot.webhookSecretRef) {
        const expectedSecret = await deps.credentialService.load(bot.webhookSecretRef);
// 只比字符串相等。缺失 expectedSecret 时放行（配置未启用校验），
// 但“配置了 ref 却读不到”与“读到空值”在此无法区分，属于已知的可观测性缺口。
        if (expectedSecret && expectedSecret !== inboundSecret) {
// 校验失败推一条用户可见提示再 continue：该消息不进入业务、也还没占用幂等键，
// 平台重投时仍有机会通过（例如凭据刚被修复）。
          replies.push(createOutbound(inbound.actor, msg(locale, "webhookSecretInvalid")));
          continue;
        }
      }
// 飞书分支的校验发生在解析之后：token 可能在顶层或 header，且 preparedPayload 已被适配器改写，
// 因此必须用最终 payload 而不是原始 payload 取 token，否则解密/转发过的回调会被误判。
      if (bot && isFeishuBotProvider(bot.provider) && bot.webhookSecretRef) {
// 每条消息都重新 load 一次凭据，而不是复用 3735 行那次：ref 可能不同（多 bot），
// 且上一处只在“有 callbackBot”时执行；这里按每条 inbound 自己的 bot 校验。
        const expectedToken = await deps.credentialService.load(bot.webhookSecretRef);
        const payloadHeader =
          isRecord(preparedPayload) && isRecord(preparedPayload.header)
            ? preparedPayload.header
            : null;
        const inboundToken =
          isRecord(preparedPayload) && typeof preparedPayload.token === "string"
            ? preparedPayload.token
            : typeof payloadHeader?.token === "string"
              ? payloadHeader.token
              : undefined;
// 与顶部一致：expectedToken 为空说明配置了 ref 但取不到，视为不可验证，直接拒绝。
        if (expectedToken && expectedToken !== inboundToken) {
          replies.push(createOutbound(inbound.actor, msg(locale, "webhookSecretInvalid")));
          continue;
        }
      }
// inboundMessage 允许被 enrich（displayName），但 botId/provider/chatId 等身份字段绝不改写：
// 它们已经参与幂等键与授权查找，改了会让 releaseInboundDelivery 对不上同一个 key（INV-03）。
      let inboundMessage = inbound;
// 只有缺 displayName 且适配器支持时才发通讯录请求：这是可选的展示增强，
// 已有名字时再查一次纯属浪费；群消息量大会把通讯录接口打成瓶颈。
      if (bot && !inbound.actor.displayName && adapter.resolveActorDisplayName) {
        try {
          const displayName = await adapter.resolveActorDisplayName(bot, inbound.actor);
// 空白串视为未解析：平台可能返回 " " 之类的占位值，直接 trim 后判空再写回。
          if (displayName?.trim()) {
// 重建对象而不是给 inbound.actor 赋值：inbound 可能被 adapter 缓存或复用，
// 原地改会污染下一次解析结果。
            inboundMessage = {
              ...inbound,
              actor: {
                ...inbound.actor,
                displayName: displayName.trim(),
              },
            };
          }
// [失败路径] catch 只降级日志、不重抛，并保留原 inboundMessage：
// displayName 缺失不影响幂等键、授权判定与后续命令，重抛会把整次回调变成失败。
        } catch (error) {
          // Bugfix: 飞书 displayName 需要额外通讯录权限，权限缺失时不能阻断消息处理和绑定。
          botsLogger.debug(
            undefined,
            `resolve actor displayName failed provider=${provider} bot=${inbound.botId} user=${inbound.actor.providerUserId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
// INV-03：幂等键必须在任何副作用（建任务、写状态、发消息）之前占位。
// 返回 false 表示同一 (bot, provider, chat, providerMessageId) 在 2 分钟窗口内已处理过，
// 直接跳过；若放到副作用之后占位，重复投递会先把任务建出来再被判重，等于白建一次。
      if (!markInboundDelivery(inboundMessage)) {
        botsLogger.debug(
          undefined,
          `provider callback duplicated provider=${provider} bot=${inboundMessage.botId} user=${inboundMessage.actor.providerUserId} messageId=${inboundMessage.actor.providerMessageId ?? ""}`,
        );
        continue;
      }
      botsLogger.debug(
        undefined,
        `provider callback provider=${provider} bot=${inboundMessage.botId} messageId=${inboundMessage.actor.providerMessageId ?? ""}`,
      );
      // 回调失败和重连也走相同的话题提醒规则，保留 Provider 核验的提及事实。
// 用 === true 归一化而不是 Boolean(...)：回调来源的同名字段可能是字符串 "false"，
// 宽松转换会把它当成已 @，从而绕过“无 @ 续聊需模型参与”的判定。
      inboundMessage = {
        ...inboundMessage,
        actor: { ...inboundMessage.actor, mentionedBot: inboundMessage.mentionedBot === true },
      };
// outbound 与 reconnectStartingReply 分开保存：前者是“最终结果”，后者是“开始态”，
// 二者由 handleReconnect 的不同时机产出，合并成一个数组会让开始态排到结果之后。
      let outbound: BotOutboundMessage[];
      let reconnectStartingReply: BotOutboundMessage | null = null;
      let inboundBusinessFailure = false;
// 命令解析用 commandText ?? text：commandText 只用于命令/唤醒识别，保留原文 text 的完整性。
      try {
        const command = parseBotCommand(inboundMessage.commandText ?? inboundMessage.text);
// 只有“非 bot 自己发的 reconnect 命令”才走重连：senderType === "app" 的消息如果也触发重连，
// 重连后自己再发一条消息就会被自己再次触发，形成无限重连循环。
        if (bot && inboundMessage.senderType !== "app" && command.type === "reconnect") {
          outbound = await handleReconnect(inboundMessage, {
// onReconnectStart 在 ensureConnected 之前回调：此刻把“正在重连”实时发给用户，
// 否则只会在重连结束后才拿到结果，开始态已经过期（见下方 Bugfix 注释）。
            onReconnectStart: async (auth) => {
              reconnectStartingReply = createOutbound(
                inboundMessage.actor,
                msg(auth.locale, "remoteReconnectStarting", {
                  workspacePath: auth.context.workspacePath,
                }),
              );
              await sendOutbound(bot, reconnectStartingReply);
            },
          });
        } else {
// 其余命令与普通消息都交给主流程；这里不做任何前置鉴权，
// 授权在 handleInboundMessage 的群命令入口统一判定（INV-01）。
          outbound = await service.handleInboundMessage(inboundMessage);
        }
// [失败路径] 业务异常在这里被吸收成一条用户可见错误，而不是让整次回调 5xx：
// 同一次回调里的其它消息仍应被处理，不能让一条消息的失败连带丢弃后面的消息。
      } catch (error) {
// INV-03：异常必须归还幂等键，否则平台重投时会被判重永久吞掉，
// 用户看到“处理失败”但重试也不会有任何效果。
        releaseInboundDelivery(inboundMessage);
// hadBusinessFailure 决定最终 ok；inboundBusinessFailure 只决定“这条消息的 ACK 是否放弃”，
// 两者不能合并：前者要阻止外部游标提交，后者要阻止卡片被标记为已处理。
        hadBusinessFailure = true;
        inboundBusinessFailure = true;
        const message = error instanceof Error ? error.message : String(error);
// 用户可见文案走 formatUserFacingBotError：内部错误（堆栈/路径/凭据）不能直接暴露给 IM 用户。
        const userFacingMessage = formatUserFacingBotError(error, locale);
        botsLogger.warn(
          undefined,
          `provider callback failed provider=${provider} bot=${inboundMessage.botId} user=${inboundMessage.actor.providerUserId}: ${message}`,
        );
// administratorErrorReply 负责“群内只让管理员看到详情”，普通成员拿到通用文案；
// 组装成一条 outbound 而不是直接发送，是为了让它走统一的发送/卡片终态路径。
        outbound = [
          administratorErrorReply(
            inboundMessage.actor,
            bot,
            error,
// 会话过期是独立的用户动作提示（需要重新授权），再套一层 callbackFailed 会误导用户以为回调坏了。
            createOutbound(
              inboundMessage.actor,
              isSessionExpiredError(error)
                ? userFacingMessage
                : msg(locale, "callbackFailed", { message: userFacingMessage }),
            ),
          ),
        ];
      }
// 开始态先入 replies（transport 取 replies[0] 作为同步响应），再追加最终结果；
// 顺序不能反：飞书卡片同步响应只消费第一条。
      if (reconnectStartingReply) {
        replies.push(reconnectStartingReply);
      }
      replies.push(...outbound);
// 失败分支不返回 ok:false，而是先把错误提示真正发出去：
// 返回的 replies 在长连接路径上不会逐条发送（只取 replies[0]），只 push 不发送等于用户什么都看不到。
      if (inboundBusinessFailure) {
        // Bugfix：错误提示发送成功不等于业务消息已经消费成功。此处不能执行 callback ACK，
        // 否则飞书会移除按钮；最终 ok=false 也会阻止 Telegram/微信提交外部游标。
// bot 为空（配置被删）时连发送目标都没有，只能靠 ok:false 让平台重投/记录。
        if (bot) {
          for (const outboundMessage of outbound) {
// 单条失败提示发送失败只 warn：它已经是错误路径，再抛错会掩盖原始业务错误，
// 也会跳过下面的 stopInboundTyping 清理。
            await sendOutbound(bot, outboundMessage).catch((sendError) => {
              botsLogger.warn(
                undefined,
                `provider callback failure notice failed provider=${provider} bot=${bot.id}: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
              );
            });
          }
// typing 是尽力而为的 UI 状态；取消失败与业务错误无关，必须吞掉（INV-09 的降级精神）。
          await stopInboundTyping(bot, inboundMessage.actor).catch(() => undefined);
        }
// 这里 continue 而不是 break：同一次回调里的其它消息仍要处理，
// 否则一条失败会连带吞掉后面已经解析出来的消息。
        continue;
      }
      if (bot) {
// transientCard 是本 actor 在飞书流式卡片模式下“正在交互的那一张卡”的句柄，
// 只存在于内存（transientInteractionCards）；进程重启后即为 undefined，后续会自动新建。
        const transientCard = transientInteractionCards.get(
          getActorContextKey(inboundMessage.actor),
        );
// 判断“这次回调用同步卡片响应就已经表达了结果”，条件缺一不可：
// ① zcodeFeishuSynchronousCardAction：由 card.action.trigger handler 注入；
// ② deferred !== true：业务在 2s 内完成，同步响应真的送出去了；超时后必须走异步 ACK；
// ③ outbound[0] 存在；④ 群卡片操作只要 toast（不覆盖共享卡片）。
        const handledByFeishuSynchronousCardAction =
          isFeishuBotProvider(provider) &&
          isRecord(preparedPayload) &&
// deferred 为 true 说明 transport 已放弃同步响应（三秒限制），此时 ACK 必须照常发送，
// 否则卡片会一直显示“处理中”。
          ((preparedPayload.zcodeFeishuSynchronousCardAction === true &&
            !(
              isRecord(preparedPayload.zcodeFeishuCardResponseState) &&
              preparedPayload.zcodeFeishuCardResponseState.deferred === true
            ) &&
            Boolean(outbound[0])) ||
// 群卡片操作 + 纯 toast 回复：结果是私密提示，不应该被当成“卡片已更新”，
// 否则群共享卡会停在旧状态而没有人去刷新它。
            (inboundMessage.groupCardAction === true && outbound[0]?.callbackToastOnly === true));
        // Bugfix: 只做空 ACK 会让 Telegram 顶部 loading 消失但没有任何可见反馈。
        // 这里在业务处理后把结果写进 answerCallbackQuery 的 toast，即使后续 sendMessage 失败，用户也能看到按钮结果。
// toast 只能承载一段文本，所以取 outbound[0]；平台对空文本会直接丢包，
// 因此还要回落到 "received" 保证用户至少看到一次可见反馈。
        const callbackText = outbound[0]?.text ?? msg(locale, "received");
        let acknowledgeResult:
          | Awaited<ReturnType<NonNullable<typeof adapter.acknowledgeCallback>>>
          | undefined;
// 每次 ACK 用独立 AbortController：超时只能中断本次调用，
// 不能复用全局 signal，否则一次超时会把后续所有回调的 ACK 一起废掉。
        const acknowledgeController = new AbortController();
// 定时器只负责 abort，真正的超时语义由 race 的第二个 promise 兑现；
// 这样适配器即使完全不响应 signal，race 也能按时结束。
        const acknowledgeTimeout = setTimeout(() => {
          acknowledgeController.abort(
            new Error(
// error 文本里带 BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS，看日志就能判断是平台慢还是本机网络慢。
              `Bot provider callback acknowledgement timed out after ${BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS}ms.`,
            ),
          );
        }, BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS);
        try {
// 这里的 race 是“业务完成”与“超时”的竞速，而不是重试：
// ACK 只是让平台停止 loading，业务结果已经确定，重复 ACK 反而会让 callback token 失效。
          acknowledgeResult = await Promise.race([
// 两种情况跳过 ACK：同步卡片响应已经完成交互；或交互卡在没有新 elicitation 时无需重新提示。
// 注意带 elicitation 时不跳过——下一题必须靠 callback token 推进。
            handledByFeishuSynchronousCardAction || (transientCard && !outbound[0]?.elicitation)
              ? Promise.resolve(undefined)
              : adapter.acknowledgeCallback?.(
                  bot,
                  preparedPayload,
                  callbackText,
                  outbound[0],
                  acknowledgeController.signal,
                ),
// 第二个 promise 永远不 resolve，只能被 abort reject：
// 若写成 Promise.resolve()，race 会立刻完成，超时保护形同虚设。
            new Promise<never>((_resolve, reject) => {
// once: true 保证 abort 只 reject 一次；正常完成时该监听不会被移除，
// 但 signal 与 promise 同生命周期，随本次调用一起被回收。
              acknowledgeController.signal.addEventListener(
                "abort",
                () => reject(acknowledgeController.signal.reason),
                { once: true },
              );
            }),
          ]);
// [失败路径] ACK 失败只 warn，不改变业务结果：回答可能已经被 Agent 接受，
// 因为 ACK 失败就返回 ok:false，会让平台重投并重复提交同一交互（INV-11）。
        } catch (error) {
          // 修复原因：飞书第二题原本必须等待 card/update 完成；credential 或 SDK 内部
          // 任一步骤悬挂都会压住 fallback。主流程自己设 deadline，超时后立即另发下一题。
// catch 覆盖整个 race 而不只是适配器调用：适配器抛错与超时 reject 走同一出口，
// 保证两条路径都只降级日志，不会让“平台慢”变成“回调失败”。
          botsLogger.warn(
            undefined,
            `provider callback acknowledge failed provider=${provider} bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
// finally 必须清掉定时器：否则一个 3s 的悬空 timer 会拖住进程退出/测试结束。
        } finally {
          clearTimeout(acknowledgeTimeout);
        }
// 只有“同步卡片响应”或“适配器明确回报 handled”才算结果已经由卡片表达；
// 适配器返回 void/undefined 时必须继续走普通发送，否则用户收不到任何回复。
        const callbackHandledByCardUpdate =
          handledByFeishuSynchronousCardAction || acknowledgeResult?.handled === true;
// 管理员待办被标记 callbackToastOnly 只是为了避免覆盖群共享卡片，
// 但 toast 一闪而过，管理员可能永远看不到，因此需要单独补发。
        const administratorNotice = outbound.find(
          (reply) => reply.callbackToastOnly && reply.administratorAttention,
        );
        if (callbackHandledByCardUpdate && administratorNotice) {
// 补发时清掉 callbackToastOnly/administratorAttention 两个内部标记：
// 它们只影响投递策略，若继续保留，sendOutbound 会再次按 toast 处理。
          await sendOutbound(bot, {
            ...administratorNotice,
            callbackToastOnly: undefined,
            administratorAttention: undefined,
          });
        }
// 这个分支只在“异步 ACK 且还有下一题”时进入：
// 排除同步卡片响应（否则会和 SDK 对同一 message_id 竞争刷新），也排除无 elicitation 的终态
// （那种情况交给下面的 finalize 分支，避免同一张卡被两条路径各写一次）。
        if (
          !handledByFeishuSynchronousCardAction &&
          callbackHandledByCardUpdate &&
          transientCard &&
          outbound[0]?.elicitation
        ) {
          // 修复原因：真实飞书日志确认 card/update 返回成功后客户端仍可能停在旧题。
          // callback token 负责点击 ACK，随后再 PATCH 同一 message_id 强制刷新可见结构；
          // 两次写入始终指向同一张卡，禁止退回“新建后撤回”的闪烁方案。
// [资源] 通过 transientCard 自己的 provider 重新取 adapter，而不是用当前回调的 adapter：
// 卡片可能由另一个 bot/渠道创建，句柄只在该 adapter 下有效。
          await providers[transientCard.bot.provider]
            ?.updateTransientInteractionCard?.(transientCard.bot, transientCard.handle, outbound[0])
// [失败路径] catch 返回 resolved，调用链继续执行 stopInboundTyping 与结果组装；
// 若在这里 rethrow，会落到 4112 的 releaseInboundDelivery 并让整次回调以 503 结束，
// 平台重投就会把同一个交互再提交一次。
            .catch((error) => {
              // 业务回答已被 Agent 接受且 callback token 已完成 ACK，PATCH 失败不能让
              // Telegram/微信式外部游标重试整次回答，否则会重复提交同一交互。
              botsLogger.warn(
                undefined,
                `refresh transient interaction card failed provider=${provider} bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        }
        if (
          callbackHandledByCardUpdate &&
          transientCard &&
          !outbound[0]?.callbackToastOnly &&
          outbound[0]?.elicitation?.status !== "pending"
        ) {
          // 修复原因：card_update_token 已把同一消息更新为只读终态，此时只释放内存句柄，
          // 不能再 PATCH、DELETE 或另发结果卡。
// 不删除句柄的后果：下一次交互仍走 upsert 分支，PATCH 一张已只读的卡片，
// 飞书会拒绝更新，用户既看不到新题，也收不到可重试的错误。
          transientInteractionCards.delete(getActorContextKey(inboundMessage.actor));
        }
        // Bugfix: /reconnect 的“正在重连”必须在 ensureConnected 前实时发送。
        // handleReconnect 只返回最终结果，避免重连完成后才把过期的开始状态一起吐给用户。
        try {
// callbackHandledByCardUpdate 为 true 时循环体为空：同步卡片响应已经把 outbound[0]
// 送回客户端，再逐条发送就是重复消息；这个跳过只影响这批 outbound，不影响后续 stopInboundTyping。
          for (const outboundMessage of callbackHandledByCardUpdate ? [] : outbound) {
// 只有“非 toast”的回复才复用同一张交互卡：toast 是私密提示，写进群共享卡会泄漏给所有人。
            if (transientCard && !outboundMessage.callbackToastOnly) {
// selection 或 pending elicitation 都要 PATCH 原卡：交互还在进行，
// 新建卡会让用户面对两张都能点的卡（INV-11 的选项 id 也会失去唯一归属）。
              if (outboundMessage.selection || outboundMessage.elicitation?.status === "pending") {
                await upsertTransientInteractionCard(
                  bot,
                  inboundMessage.actor,
                  transientCard.taskId,
                  outboundMessage,
                );
                continue;
              }
// 交互已终结（elicitation 终态，或 /approve//deny 文本命令）：更新为无控件卡片并释放句柄。
// 命令分支必须单独判断，因为它们没有 elicitation 结构，只靠文本前缀识别。
              if (
                outboundMessage.elicitation ||
                /^\/(?:approve|deny)(?:\s|$)/u.test(inboundMessage.text)
              ) {
                await finalizeTransientInteractionCard(inboundMessage.actor, outboundMessage);
                continue;
              }
            }
// 非交互卡的普通回复统一走 sendOutbound，避免复用交互卡时把进度态写进消息流。
            await sendOutbound(bot, outboundMessage);
          }
// 入站处理结束必须停止 typing：否则长连接上的“输入中”状态会一直挂着，
// 直到下一个 typing 周期或进程退出。
          await stopInboundTyping(bot, inboundMessage.actor);
        } catch (error) {
// [权衡] 发送阶段失败也归还幂等键（INV-03 的字面要求），但此时业务副作用可能已经发生
// （任务已创建、回答已提交）。平台重投会再次执行同一命令。
// 这里保留归还，是为了不让“发送失败”变成永久静默丢消息；重复执行的代价由下游幂等承担。
          releaseInboundDelivery(inboundMessage);
// 向上抛：transport 看到异常会记录并可能重投，错误提示已经发过，
// 不能让失败被吞掉后仍然返回 ok:true。
          throw error;
        }
      }
    }
// 只要有任一消息业务失败，整次回调 ok:false；status 503 让 webhook 型平台重投。
// [权衡] 与 4112 的归还叠加后，重投会重新执行；这正是“失败必须可重试”与“副作用只做一次”
// 之间的取舍点，当前选择偏向可重试。
    return {
      ok: !hadBusinessFailure,
      replies,
      ...(hadBusinessFailure ? { status: 503 } : {}),
    };
  }

// 把 CLI 侧的 assistant parts + 工具调用状态投影成 IM 可渲染的回复块。
// 输入 toolCalls 是 Map（按 toolId 索引的权威状态），parts 只提供顺序与文本；
// 输出块序列由 replyFormatter 负责截断/本地化，这里不做任何字符串格式化。
// 纯函数、无副作用；调用方既用于最终回复，也用于“只发变更摘要”的补发路径。
  function createAssistantReplyBlocks(
    parts: readonly ZCodeAssistantMessagePart[],
    toolCalls: ReadonlyMap<string, BotReplyToolCallState>,
    mode: BotReplyGranularity | undefined,
    changeSummary: ZCodeTaskMeta["changeSummary"] | null | undefined,
  ): BotAssistantReplyBlock[] {
    const blocks: BotAssistantReplyBlock[] = [];
// mode 可能来自任务创建时的旧配置或未知渠道，undefined 时回落到默认粒度；
// 直接使用 mode 会让 undefined 落入下面的 else 分支，意外输出全部正文+工具。
    const resolvedMode = mode ?? getDefaultBotReplyGranularity();
// content 传空串、只喂 parts：正文已按 part 顺序存在于 parts 中，
// 再传 content 会让 presentation 生成重复的 fallback 内容块。
    const presentation = buildZCodeAssistantPresentation({
      content: "",
// 重建工具调用数组并补 kind/status 默认值：BotReplyToolCallState 这两个字段可选，
// 而 buildZCodeAssistantPresentation 需要完整状态才能生成稳定的工具摘要。
// 用展开复制而非原地赋值，避免修改调用方持有的 Map 内容。
      toolCalls: [...toolCalls.values()].map((toolCall) => ({
        ...toolCall,
        kind: toolCall.kind ?? "tool",
        input: toolCall.input,
// pending 是“尚未开始/进行中”的兜底状态，保证渲染层永远拿到合法枚举值。
        status: toolCall.status ?? "pending",
      })),
      parts,
    });

// summary_changes 的语义是“只发最后一轮结论”：历史中间过程对 IM 用户是噪音，
// 也容易撑爆消息长度上限导致截断。
    if (resolvedMode === "summary_changes") {
// latestPart 为空表示最后一轮没有正文（纯工具调用），此时不产出 content 块，
// 由后面的 changeSummary 决定是否还有内容可发。
      if (presentation.latestPart?.content.trim()) {
        blocks.push({
          type: "content",
          content: presentation.latestPart.content,
        });
      }
// 其它模式按 presentation 的真实顺序遍历，保证正文与工具调用的相对位置与桌面端一致。
    } else {
      for (const block of presentation.blocks) {
// trim 后为空的内容块直接丢弃：空白块在 IM 里会变成一条空消息或多余空行。
        if (block.type === "content" && block.content.trim()) {
          blocks.push({ type: "content", content: block.content });
          continue;
        }
// 只有 assistant_toolcalls_changes 输出工具块。assistant_changes 若也输出，
// 一次多工具任务会刷出十几条工具消息，把真正的回答挤出屏幕。
        if (resolvedMode !== "assistant_toolcalls_changes" || block.type !== "tool-call") {
          continue;
        }
// 用 Map 里的状态覆盖 block 中携带的投影副本：block 只包含渲染所需的最小字段，
// 而 Map 里才有最新的 status/output；取 block 副本会让已完成的工具显示成 running。
        const toolCall = toolCalls.get(block.toolCall.toolId);
// Map 里没有就跳过：parts 可能包含已被清理的工具调用，
// 用残缺副本渲染会输出没有状态、没有结果的空工具块。
        if (toolCall) {
          blocks.push({ type: "tool-call", toolCall });
        }
      }
    }

// 变更摘要必须同时有 fileCount 与 files：只有计数没有明细时格式化器无法列出文件，
// 会产出一条“改了 N 个文件”但没有内容的空块，不如不发。
    if (changeSummary && changeSummary.fileCount > 0 && changeSummary.files.length > 0) {
// 追加在最后：摘要描述的是整轮结果，放在正文/工具之后才符合阅读顺序。
      blocks.push({ type: "change-summary", changeSummary });
    }
// 空数组是合法结果（例如 summary 模式下最后一轮无正文且无变更），
// 调用方据此决定是否走“任务已完成”兜底，因此不能返回 undefined。
    return blocks;
  }

// 把两种 elicitation 事件形状归一成统一的 questions 数组：
// 旧版是 message/header/options 的单问题，新版是 questions[]。归一后 pending 存储、
// 回答索引、表单渲染都只需处理一种结构，避免形状判断扩散到十几处调用点。
  function normalizeBotElicitationQuestions(
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
    locale: Locale | undefined,
  ): ZCodeElicitationQuestion[] {
// schema 是 unknown：只做 isRecord 收窄，不对未知字段做类型断言，
// 否则平台/CLI 版本不一致时会抛 TypeError 打断整个交互。
    const schema = isRecord(event.schema) ? event.schema : null;
// plan_approval 由 schema.interaction 判定，而不是看文案或选项文本：
// 文案可本地化、可被模型改写，只有 schema 是结构化契约（INV-11 的稳定标识原则）。
    const isPlanApproval = schema?.interaction === "plan_approval";
// 计划审批固定为单题单选项：语义上只有“批准”与“自定义修改意见”，
// 因此不信任 event.options，避免模型附带多余选项让用户误以为可以多选。
    if (isPlanApproval) {
      return [
        {
// header 与 label 全部走本地化文案：审批按钮必须与界面语言一致，
// 硬编码中文会让 en-US 用户看到混合语言卡片。
          question: msg(locale, "planApprovalTitle"),
          header: msg(locale, "planApprovalHeader"),
          options: [
            {
              value: "approve",
              label: msg(locale, "planApprovalApprove"),
              description: msg(locale, "planApprovalApproveDescription"),
            },
          ],
        },
      ];
    }
// questions 优先；为空才回退到旧形状。用 length > 0 而不是真值判断，
// 因为空数组在布尔上为真，会造出 0 个问题的 pending（后续 currentQuestionIndex 全部越界）。
    const sourceQuestions =
      event.questions && event.questions.length > 0
        ? event.questions
// 旧形状只有一个问题：把 message/header/options 摊平成与 questions[0] 同构的对象，
// 后续 map 就不需要再区分两种输入。
        : [
            {
              question: event.message,
// header 缺失时回退到 message：卡片标题不能为空，否则渲染出一块空白区域。
              header: event.header ?? event.message,
// options 在旧形状下可能是 undefined，映射时由 ?. 容错（纯文本渠道允许没有选项）。
              options: event.options,
// multiSelect 只在为 true 时写入字段，保持 pending 落盘的最小形状。
              ...(event.multiSelect ? { multiSelect: true } : {}),
            },
          ];
// 用 map 重建每个问题，而不是原地补默认值：event 可能被上层缓存/复用，
// 原地改会让下一次（重连重投）归一化看到已被改写的数据。
    return sourceQuestions.map((question) => ({
      question: question.question,
// header 空串回退到 question：IM 卡片必须始终有可点击/可读的标题。
      header: question.header || question.question,
      options: question.options.map((option) => ({
        value: option.value,
// label 为空回退到 value：空 label 会渲染成没有文字的按钮，用户无法点选。
        label: option.label || option.value,
// description 不设默认值（undefined 表示无说明），避免格式化器输出空括号。
        description: option.description,
      })),
// 同样只在 true 时保留字段，与上面的统一口径一致。
      ...(question.multiSelect ? { multiSelect: true } : {}),
    }));
  }

// 从 elicitation 事件里提取“渲染计划审批所必需的上下文”，存进 pending 以便后续每次重绘都能还原。
// 返回 undefined 表示不是计划审批，调用方据此走普通问答分支。
  function readBotElicitationRenderContext(
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
  ): BotPendingElicitation["renderContext"] {
// schema 必须是 record；否则连 interaction 都读不到，直接按普通问答处理。
    const schema = isRecord(event.schema) ? event.schema : null;
    if (
// 三重条件：确实是 plan_approval、plan 是字符串、且 trim 后非空。
// 只判断 interaction 会把空计划当成审批上下文，标题里出现一段空白（见 formatBotElicitationTitle）。
      schema?.interaction !== "plan_approval" ||
      typeof schema.plan !== "string" ||
      !schema.plan.trim()
    ) {
      return undefined;
    }
// 存 trim 后的副本：原始 plan 可能带首尾空行，卡片/纯文本渲染会多出无意义空行。
// [权衡] 不落整个 schema：它可能包含内部字段且体积大，写进 BotsRepo 会膨胀状态并可能泄漏实现细节。
    return { kind: "plan_approval", plan: schema.plan.trim() };
  }

// 由 pending 反向重建 elicitation schema，供出站卡片与结果快照使用。
// 只有 plan_approval 有可重建的结构；普通问答返回 undefined，调用方用条件展开避免写出 schema: undefined。
  function createPendingElicitationSchema(
    pending: BotPendingElicitation,
  ): Record<string, unknown> | undefined {
// 每次新建对象而不是缓存引用：返回的对象会进入 outbound，可能被适配器/transport 改写，
// 共享引用会把一次渲染的修改带到下一次。
    return pending.renderContext?.kind === "plan_approval"
      ? { interaction: "plan_approval", plan: pending.renderContext.plan }
      : undefined;
  }

// answers 的键用问题下标（字符串化），而不是问题文本：
// 同一 request 内允许重复问题文本（例如两个“是否继续”），用文本做键会互相覆盖答案。
// 下标在一次 request 生命周期内稳定，这是 INV-11“渲染到回调 id 稳定”的一部分。
  function getElicitationAnswerKey(questionIndex: number): string {
// 显式 String()：answers 是 Record<string, string[]>，落盘 JSON 的键本来就是字符串，
// 在读取处再做数字↔字符串转换容易漏掉某一处，统一在写入点归一。
    return String(questionIndex);
  }

// 读取某题的已选值。缺失时返回空数组而不是 undefined：
// 上游（单选渲染、表单合并）都按数组语义使用，返回 undefined 会让 ?. 与展开分散到各调用点。
  function readElicitationAnswerValues(
    pending: BotPendingElicitation,
    questionIndex: number,
  ): string[] {
// [权衡] 这里直接返回 pending.answers 中的数组引用，没有复制。
// 现有调用方都只读或先展开再改；若将来有调用方原地 push，会静默污染落盘的 pending。
    return pending.answers[getElicitationAnswerKey(questionIndex)] ?? [];
  }

// 生成“这一轮问题”的选择令牌，用于把按钮点击/文本回答绑回具体的 task+run+request+题目。
// 输入是 pending 的四个稳定标识，输出 12 位十六进制串（sha256 截断）。
// 该令牌不是安全边界：它只防“陈旧点击/跨轮误答”，真正的归属校验仍走 isPendingElicitationOwnedByActor。
  function getPendingElicitationSelectionToken(pending: BotPendingElicitation): string {
// 用 sha256 而不是自增计数：令牌要能由 pending 纯函数式重算，
// 不能依赖进程内状态（重启后 pending 从磁盘恢复，计数会归零导致重算不一致）。
    return createHash("sha256")
      .update(
// 三个 id 加题目下标一起进哈希：跨 task、跨 run、以及同一 request 内的不同题目都必须区分。
// 只哈希 requestId 的话，多题问答里第一题的按钮在第二题仍然有效，会替用户答错题。
        [pending.taskId, pending.runId, pending.requestId, pending.currentQuestionIndex].join("::"),
      )
      .digest("hex")
// 截断到 12 位（48 bit）：令牌要能塞进 Telegram callback data 与卡片按钮 value，
// 长度受限；碰撞概率对“防止误点”这个用途足够，且服务端还会再比对一次完整 pending。
      .slice(0, 12);
  }

// “跳过”选项的 id 每轮都带令牌，因此上一轮卡片的跳过按钮在新一轮会立即失效。
// 若用固定 id `__skip__`：用户点旧卡的跳过，就等于替当前新问题做了“跳过”，
// 这正是 INV-11 要禁止的“选项 id 跨轮复用”。
  function getPendingElicitationSkipOptionId(pending: BotPendingElicitation): string {
// 保留前缀 + 冒号分隔，便于日志与解析时一眼看出这是保留 id 而不是普通选项值。
    return `${BOT_ELICITATION_SKIP_OPTION_ID}:${getPendingElicitationSelectionToken(pending)}`;
  }

// 解析按钮/文本里携带的“令牌 + 回答值”。
// 出站时把 token 与 value 用空格拼成一个字符串，是因为多数 IM 的回调数据只有单值通道且长度受限。
// 返回 { token?, value }：token 缺失表示这是纯文本回答（微信）而非按钮回调。
  function parseElicitationResponseValue(value: string): {
    token?: string;
    value: string;
  } {
// trim 后再切分：平台可能带首尾空白；按空白切分而不是按冒号，
// 因为选项值本身可能含冒号（模型生成的自由文本）。
    const trimmed = value.trim();
    const [maybeToken, ...rest] = trimmed.split(/\s+/u);
// 只有“第一段像令牌且后面还有内容”时才认定 token。
// 若整串就是一个 12 位 hex，它更可能是选项值本身，误判会把用户答案吞掉。
    if (maybeToken && rest.length > 0 && /^[a-f0-9]{12}$/iu.test(maybeToken)) {
// token 统一小写：哈希输出是小写，但按钮数据经过某些平台可能被大写化。
// rest.join(" ") 还原值内部的空格，避免多词答案被切成多个片段。
      return { token: maybeToken.toLowerCase(), value: rest.join(" ") };
    }
    return { value: trimmed };
  }

// 解析自定义输入表单值（`__form__:` 前缀），返回数组；返回 null 表示“这不是表单值”。
// null 与 [] 的区别是语义关键：[] 表示是表单但解析失败/为空，调用方要重绘当前题而不是当文本答案。
  function parseElicitationFormValues(value: string): string[] | null {
// 用前缀区分表单与普通选项，而不是另加字段：IM 只有单一 value 通道，
// 前缀是最小侵入的做法，也与 INV-11 的保留 id 约定一致。
    if (!value.startsWith(BOT_ELICITATION_FORM_VALUE_PREFIX)) {
      return null;
    }
// 先去掉前缀再解码。decodeURIComponent 必须在 JSON.parse 之前：
// JSON 里的引号/换行只有经过 URL 编码才能安全放进回调数据。
    const encoded = value.slice(BOT_ELICITATION_FORM_VALUE_PREFIX.length);
    try {
// 解析结果是 unknown，不能信任形状：可能是字符串、数组、对象或 null。
      const parsed = JSON.parse(decodeURIComponent(encoded)) as unknown;
// 单值自动包成数组：同一个入口既服务单选（字符串）也服务多选（数组）。
      const values = Array.isArray(parsed) ? parsed : [parsed];
// 逐项 trim 并丢弃非字符串/空串：空答案会使 Agent 把“未回答”误读成“用户给了空偏好”。
      return values.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
// 解析失败返回 []（而不是 null）：坏表单仍属于“表单路径”，
// 调用方会重绘当前题让用户重填，而不是把 `__form__:...` 原串当成答案提交上去。
    } catch {
      return [];
    }
  }

// 合并“按钮已选值”和“自定义输入值”，产出一题的最终答案数组。
  function mergeElicitationFormValues(
    question: ZCodeElicitationQuestion,
    selectedValues: readonly string[],
    formValues: readonly string[],
  ): string[] {
// 先过滤空串：formValues 可能由旧版本或其它调用方传入，不能假设已经清洗过。
    const customValues = formValues.filter(Boolean);
// 单选时 customValues 优先于 selectedValues，并用 slice(0,1) 只取一个。
// slice(0,1) 是防御历史数据残留多个值（例如题目从多选改单选）导致单选语义被破坏。
    if (!question.multiSelect) {
      return customValues.length > 0 ? customValues.slice(0, 1) : selectedValues.slice(0, 1);
    }
// 多选：保持“已选项在前、自定义在后”，顺序稳定，
// 这样同一组答案重复渲染时不会因顺序抖动而触发多余的卡片刷新。
    const merged: string[] = [];
    for (const value of [...selectedValues, ...customValues]) {
// 去重用一个 O(n²) 的 includes：单题选项是个位数量级，用 Set 反而多一次分配。
// 若重复值进入 answers，卡片上的 [x] 标记与最终提交的答案会不一致。
      if (!value || merged.includes(value)) {
        continue;
      }
      merged.push(value);
    }
    return merged;
  }

// 展开/收起“自定义回答”输入区，返回新的 pending（不改入参）。
  function toggleElicitationCustomAnswerExpanded(
    pending: BotPendingElicitation,
  ): BotPendingElicitation {
// 用 Set 复制后再改：pending.expandedCustomAnswerQuestionIndexes 可能被上一次写盘的对象共享，
// 原地 push 会把未落盘的状态提前反映到持有旧引用的调用方。
    const current = new Set(pending.expandedCustomAnswerQuestionIndexes ?? []);
// 对称 toggle：已有则删、没有则加，保证同一题只有“展开/收起”两种合法状态。
    if (current.has(pending.currentQuestionIndex)) {
      current.delete(pending.currentQuestionIndex);
    } else {
      current.add(pending.currentQuestionIndex);
    }
    return {
      ...pending,
// 排序的原因不是美观：Set 的 delete+add 会把元素移到末尾，集合相同也可能顺序不同，
// 不排序会让持久态比较误判为“有变化”，触发无意义的 writeContext（INV-10 的写入放大）。
      expandedCustomAnswerQuestionIndexes: [...current].sort((left, right) => left - right),
    };
  }

// 把用户的自由输入/按钮值解析成“选项 id”或“原样文本”。
// 这是 INV-11 的关键环节：渲染出去的 id 必须能被稳定地逆解析回来。
  function resolveElicitationQuestionValue(
    question: ZCodeElicitationQuestion,
    value: string,
    options: { includeSubmit?: boolean } = {},
  ): string {
// 空输入返回空串；调用方用 `if (!selectedValue)` 判断无有效选择并重绘当前题。
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
// normalizeText 做大小写/全半角/空白归一，让 "Done"、"完成"、"__submit__" 走同一判定。
    const normalized = normalizeText(trimmed);
// 提交词只在“多选 + 允许提交”时解释。单选时用户输入 "done" 很可能就是想选某个叫 done 的选项，
// 直接当提交会吞掉真实答案。
    if (
      question.multiSelect &&
      options.includeSubmit !== false &&
// 提交词的集合包含本地化文本与保留 id：卡片按钮回传的是 id，文本渠道回传的是人话，
// 两条路径必须归一到同一个 id。
      ["submit", "done", "完成", "提交", BOT_ELICITATION_SUBMIT_OPTION_ID].includes(normalized)
    ) {
      return BOT_ELICITATION_SUBMIT_OPTION_ID;
    }
// 选项匹配放在提交判定之后、序号提交判定之前：
// resolveOptionByValue 同时支持 id、label、数字序号，能覆盖绝大多数合法输入。
    const option = resolveOptionByValue(
      question.options.map((item) => ({ id: item.value, label: item.label })),
      trimmed,
    );
// 命中就返回规范 id，而不是用户输入的 label/序号：
// 下游按 id 存 answers 与判断 toggle，用 label 会在本地化切换后失配。
    if (option) {
      return option.id;
    }
// 这里只解析数字用于“超出选项范围的序号”判定；能走到这里说明前面的选项匹配没命中。
    const index = Number.parseInt(trimmed, 10);
// “序号等于 options.length + 1”视为提交：渲染时提交按钮正是追加在最后一个选项之后的第 N+1 项。
// 这个判定必须放在选项匹配之后，否则选项数恰好等于某个合法序号时会被误判成提交。
    if (
      question.multiSelect &&
      options.includeSubmit !== false &&
// 只接受 [1-9]\d*：0 与负数不是合法序号，不能当作提交。
      /^[1-9]\d*$/u.test(trimmed) &&
      index === question.options.length + 1
    ) {
      return BOT_ELICITATION_SUBMIT_OPTION_ID;
    }
// 都不是则原样返回（trim 后）：这是“自定义答案”路径，必须保留用户原文，
// 否则自由输入会被静默丢弃或改写。
    return trimmed;
  }

// 判定这条 pending elicitation 是否属于当前 actor（谁有资格回答/取消）。
// 返回 true 不代表有命令权限，它只解决“这条交互是不是发给你的”这个问题。
  function isPendingElicitationOwnedByActor(
    pending: BotPendingElicitation,
    actor: BotActor,
  ): boolean {
// actorKey 缺失视为“任何人可答”，这是对旧版本 pending 的兼容：
// 旧状态没有该字段，若严格要求等于当前 actor，升级后所有在飞交互都会变成“已过期”（INV-04 的悬挂交互）。
// [权衡] 代价是这段窗口内同 chat 的其他成员也能回答；真正的授权边界仍由群 owner/绑定关系决定。
    return (
      !pending.actorKey ||
// 私聊/单聊按完整 context key 精确匹配（含 threadId、groupId 等维度）。
      pending.actorKey === getActorContextKey(actor) ||
// 群聊只匹配到 `botId::provider::chatId::` 前缀：题目属于群而不属于某个人，
// 群里任何成员都可以继续作答；若严格绑定首个点击者，第二个人点按钮会永远得到“已过期”。
      (actor.chatType === "group" &&
        pending.actorKey.startsWith(`${actor.botId}::${actor.provider}::${actor.chatId}::`))
    );
  }

// 清理与该 pending 相关的内存选择菜单，防止陈旧按钮继续被解析成有效选择。
// 只清内存，不写状态：pendingSelectionsByContext 是纯投影（INV-02）。
  function clearPendingElicitationSelection(pending: BotPendingElicitation): void {
// 先算本轮令牌，用于匹配“当前题”的 selection。
    const token = getPendingElicitationSelectionToken(pending);
// 遍历所有 context：selection 以 actor 为键，而同一 request 的旧菜单可能挂在别的 actor 键上
// （例如群内不同成员各自点过一次），因此不能只删当前 actor 的那一条。
    for (const [contextKey, selection] of pendingSelectionsByContext) {
      if (
// 双重匹配：令牌相同（本轮）或 id 前缀属于同一 request（该 request 的任意题）。
// 只按 token 清理会遗留上一题的菜单：pending 停在第二题时 token 已变，
// 用户再点第一题的旧按钮仍能命中一条已失效的 selection。
        selection.action === "elicitation.respond" &&
        (selection.token === token || selection.id.startsWith(`elicitation-${pending.requestId}-`))
      ) {
// 一边遍历一边 delete 是安全的：Map 迭代器允许删除当前项，不会跳过后续元素。
        pendingSelectionsByContext.delete(contextKey);
      }
    }
  }

// 组装提交给 Agent 的 elicitation 回答内容（content），是 Bot 与 CLI 之间唯一的答案编码点。
// 输入 answers 默认取 pending.answers；输出同时包含三种键形态，供不同版本的 Agent 读取。
// 纯函数、无副作用；调用方在 respondElicitation 前构造，失败不影响 pending 本身。
  function buildBotElicitationContent(
    pending: BotPendingElicitation,
    answers: BotPendingElicitation["answers"] = pending.answers,
  ): Record<string, unknown> {
    // 修复原因：Bot 与桌面共用“缺少 key 表示跳过”的问答契约；未答题不能写成
    // 空字符串，否则 Agent 会把它误判为用户提供的偏好。
// flatMap 一步产出 [问题文本, 答案] 二元组，并让“未作答就不产出条目”只遍历一次；
// 下标在这里只用于取答案，不参与键构造——文本键与下面的 answer_i 是两套并存契约。
    const answerEntries = pending.questions.flatMap((question, index) => {
      const values = answers[getElicitationAnswerKey(index)] ?? [];
// 多值用 ", " 连接成一段文本：这是 answers 旧契约的格式，
// 与下面 answer_i 保留数组的形态刻意不同，两种消费者各取所需。
      const text = values.join(", ").trim();
// text 为空则整条丢弃，双重保证不会写出空答案。
      return text ? [[question.question, text]] : [];
    });
    const content: Record<string, unknown> = {
// 按问题文本索引的 Object.fromEntries 需要二元组数组，这里正是上游构造的形状。
// [权衡] 问题文本重复时后一条会覆盖前一条：这是旧契约的固有限制，
// 新版以 answer_i 为主，文本索引只作为兼容兜底。
      answers: Object.fromEntries(answerEntries),
    };
// 再写一遍 answer_i：新版 Agent 按下标读取，避免文本重命名/本地化后匹配不上。
    pending.questions.forEach((question, index) => {
      const values = answers[getElicitationAnswerKey(index)] ?? [];
      if (values.length > 0) {
// 多选给数组、单选给标量：单选若给数组，Agent 侧会多包一层或只取首元素，语义变成不确定。
        content[`answer_${index}`] = question.multiSelect ? values : values[0];
      }
    });
// 单题时额外写 answer：最早版本的 schema 只认这一个字段，
// 三个键并存是跨版本兼容层，不是冗余。
    if (pending.questions.length === 1) {
      const values = answers[getElicitationAnswerKey(0)] ?? [];
      if (values.length > 0) {
// 同样按 multiSelect 决定标量/数组，保持与 answer_i 完全一致的口径。
        content.answer = pending.questions[0]?.multiSelect ? values : values[0];
      }
    }
    return content;
  }

// 生成给桌面/UI 的 elicitation 进度快照，字段命名与 CLI 的 elicitation_request 事件保持同构，
// 这样 UI 可以复用同一个渲染组件，不必为 Bot 单独维护一套结构。
  function createBotElicitationRequestSnapshot(
    pending: BotPendingElicitation,
  ): ZCodeElicitationRequest {
// 当前题越界时回退到第一题：pending 可能因题目数量变化或旧版本数据而索引失效，
// 直接取会得到 undefined，下面 message/header/options 全部落空，卡片变成空壳。
    const currentQuestion = pending.questions[pending.currentQuestionIndex] ?? pending.questions[0];
// answerDrafts 用 answer_i 作键、原样保留数组：
// 单选/多选的展示差异交给 UI 判断，快照层不做有损转换。
    const answerDrafts = Object.fromEntries(
      Object.entries(pending.answers).map(([index, values]) => [`answer_${index}`, values]),
    );
    return {
// type 固定为 elicitation_request：这是共享协议里的判别字段，UI 用它选择解析分支。
      type: "elicitation_request",
      taskId: pending.taskId,
// traceId 借用 runId：快照本身没有独立 trace，但 UI 需要用它把同一轮问答归到一起。
      traceId: pending.runId,
      requestId: pending.requestId,
// 可选字段只在有值时展开：显式写 undefined 会让 JSON 里出现空键，
// 与严格校验/落盘差分比较都不友好（会被当成状态变化）。
      ...(pending.origin ? { origin: pending.origin } : {}),
// message/header/options 取当前题而不是整组问题，是为了兼容只认单题字段的旧渲染路径；
// 完整多题信息在下面的 questions 里。
      message: currentQuestion?.question ?? "",
      header: currentQuestion?.header,
      options: currentQuestion?.options ?? [],
      ...(currentQuestion?.multiSelect ? { multiSelect: true } : {}),
// 完整问题与答案一并带上：UI 需要在同一条消息里渲染全部题目与进度。
      questions: pending.questions,
      currentQuestionIndex: pending.currentQuestionIndex,
      answerDrafts,
// createPendingElicitationSchema 调两次（条件判断 + 取值）：
// 它是纯函数且只构造小对象，可读性优先于一次分配；返回对象不共享引用。
      ...(createPendingElicitationSchema(pending)
        ? { schema: createPendingElicitationSchema(pending) }
        : {}),
    };
  }

// 把多选 toggle 后的草稿进度广播给 UI（v4 resolveInteraction 不会因草稿变化触发）。
// 该广播只是辅助同步，必须有超时：它不能阻塞同一次按钮回调里的后续卡片更新。
// [失败路径] 超时只 warn 并继续：否则用户会永久停在第一题，飞书卡片也等不到下一题。
  async function broadcastPendingElicitationProgress(
    context: BotContextState,
    pending: BotPendingElicitation,
  ): Promise<void> {
// timeout 用可空变量保存，便于 race 结束后无条件清理；没有用 AbortController，
// 因为 broadcastTaskListChange 不接受 signal（内部已经把发送错误吞掉）。
    let timeout: ReturnType<typeof setTimeout> | undefined;
// race 的两个分支：广播完成（"broadcast"）或定时器到点（"timeout"）。
// 只有这两种出口，保证这个函数一定有限时间内返回。
    const outcome = await Promise.race([
// 广播本身是 fire-and-forget（内部 .catch 吞错），所以这里不会因发送失败而被拒绝，
// 唯一需要防的是“永不 resolve 的悬挂”。
      broadcastTaskListChange(context, pending.taskId, "elicitation_request", {
        elicitationRequest: createBotElicitationRequestSnapshot(pending),
        requestId: pending.requestId,
      }).then(() => "broadcast" as const),
// 定时器回调只 resolve，不 reject：超时是预期内的降级路径，不是异常。
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(
          () => resolve("timeout"),
// 1s 的上限小于飞书 3s 的同步响应预算，给后续 sendOutbound/PATCH 留出余量。
          BOT_ELICITATION_PROGRESS_BROADCAST_TIMEOUT_MS,
        );
      }),
    ]);
// 只有 timeout 句柄存在才 clear：如果广播先完成，executor 已同步执行过，句柄一定存在；
// 这个判空只是防御未来改动把 setTimeout 挪出 executor。
    if (timeout) {
      clearTimeout(timeout);
    }
// 超时并不会取消那次广播，它仍可能在 pending 已被清理之后再推一次旧快照；
// UI 以 requestId 幂等，这里只保证本函数不再等待，不负责撤销后台广播。
    if (outcome === "timeout") {
      // 修复原因：v4/UI 进度广播只是辅助同步。广播 RPC 悬挂时若一直 await，
      // 飞书按钮回调无法生成下一题，也到不了 card/update，用户会永久停在第一题。
// 日志带 task/request：同一时刻可能有多个并发 elicitation，靠这两个 id 才能定位是哪一条慢。
      botsLogger.warn(
        undefined,
        `elicitation progress broadcast timed out task=${pending.taskId} request=${pending.requestId}`,
      );
    }
  }

// 渲染 elicitation 卡片/消息的标题（Telegram、微信等纯文本渠道的唯一可见结构）。
// 输入是 pending 与 locale；输出多行字符串，由 selection 的 title 字段承载。
  function formatBotElicitationTitle(
    pending: BotPendingElicitation,
    locale: Locale | undefined,
  ): string {
// 当前题缺失时返回 requestId 而不是空串：卡片标题必须非空，
// 否则平台侧会渲染出没有标题的裸卡片，用户不知道在回答什么。
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return pending.requestId;
    }
// 展开态只对当前题生效：多题问答切换题目后，展开标记不应带到别的题上。
    const isCustomAnswerExpanded =
      pending.expandedCustomAnswerQuestionIndexes?.includes(pending.currentQuestionIndex) === true;
// 计划审批不在这里追加“自定义回答”入口：该入口由 createBotElicitationSelection 统一补，
// 两处都加会让纯文本渠道出现两个 id 不同、语义相同的自定义选项。
    if (pending.renderContext?.kind === "plan_approval") {
      // Bugfix: Feishu 卡片能直接消费 schema.plan，但 Telegram/微信只渲染 message.text。
      // 在共享出站标题中投影完整计划，确保所有纯文本渠道都保留审批上下文。
// 用 "------" 作为纯文本分隔线：IM 没有富文本，靠一行短横区分“计划正文”和“操作区”。
      return [
// plan 原文放最前：用户需要先读到计划，才对下面的“批准”按钮有判断依据。
        pending.renderContext.plan,
        "------",
        msg(locale, "planApprovalTitle"),
// 自定义输入展开时才提示占位文案：未展开时提示没有意义，反而干扰阅读。
        isCustomAnswerExpanded ? msg(locale, "elicitationCustomPlaceholder") : null,
      ]
// 过滤 null 与空串同时收窄类型：undefined 参与 join 会变成字面量 "undefined"，
// 空串会留下多余空行。
        .filter((part): part is string => typeof part === "string" && part.length > 0)
// 空行分段：计划通常很长，段落间需要明显间隔，与普通题的紧凑排版刻意不同。
        .join("\n\n");
    }
// 普通题按固定优先级拼装：进度 → 标题 → 问题 → 多选提示 → 自定义占位 → 文本提示。
    const parts = [
// 只在多题时显示 "2/3"：单题显示 "1/1" 是噪音，也占掉卡片宝贵的标题长度。
      pending.questions.length > 1
        ? `${pending.currentQuestionIndex + 1}/${pending.questions.length}`
        : null,
// header 与 question 相同则不重复输出：多数 Agent 会复制 question 作为 header，
// 无脑拼接会让同一句话出现两遍。
      question.header && question.header !== question.question ? question.header : null,
      question.question,
// 多选提示只在多选题出现：它告诉用户“可以多选”和如何提交，
// 单选用户看到会困惑。
      question.multiSelect ? msg(locale, "elicitationMultiSelectHint") : null,
      isCustomAnswerExpanded ? msg(locale, "elicitationCustomPlaceholder") : null,
      msg(locale, "elicitationTextHint"),
    ].filter((part): part is string => typeof part === "string" && part.length > 0);
// 用单个换行连接：普通题内容短，多空行会让卡片标题过高、挤占按钮区域。
    return parts.join("\n");
  }

  function createBotElicitationSelection(
    pending: BotPendingElicitation,
    locale: Locale | undefined,
  ): SelectionPrompt {
// 把 pending elicitation 投影成 SelectionPrompt：这是“渲染 → 用户点击 → 回调”的唯一契约，
// INV-11 要求 option.id 只能是协议稳定值（option.value / __custom__ / __submit__ / __skip__:<token>），
// 不能用下标或本地化 label，否则改文案就等于改协议、旧按钮也会点到新题。
// 副作用：只读 pending.answers 生成勾选态，不写状态、不发请求。
// 题号越界时 question 为 undefined，options 退化为空；但 submit/skip 仍要补，
// 否则用户拿到一张没有任何可点项的卡（INV-04 悬挂交互）。
// 题号越界时 question 为 undefined，options 退化为空；此时仍要补 submit/skip，
// 否则用户拿到一张没有任何可点项的卡（INV-04 悬挂交互）。
    const question = pending.questions[pending.currentQuestionIndex];
    const selectedValues = new Set(
      readElicitationAnswerValues(pending, pending.currentQuestionIndex),
    );
// id 直接取 option.value：它已经是 ZCode 答案值；若改用 label 或序号，
// 模型侧答案就与界面文案耦合，改一次文案就改一次协议。
// 本地化只作用于 label/description。
    const options: SelectionPrompt["options"] =
      question?.options.map((option) => ({
        id: option.value,
// 勾选态来自 pending.answers 而非本地内存：Bot 与 UI 共享同一份草稿。
// [权衡] 用文本前缀而非平台 checkbox，是为了让微信/Telegram 文本回退也能表达多选。
        label: question.multiSelect
          ? `${selectedValues.has(option.value) ? "[x]" : "[ ]"} ${option.label}`
          : option.label,
        // Plan approval 的说明属于语义元数据；纯文本渠道只展示批准/自定义两个动作，
        // 避免把“退出计划模式”展开成额外正文，保持与 Feishu 卡片一致。
// plan approval 不展示 option.description：那是“退出计划模式”等语义元信息，
// 纯文本渠道展开后与批准动作混淆；计划正文由 renderContext 单独承载。
        description:
          pending.renderContext?.kind === "plan_approval" ? undefined : option.description,
      })) ?? [];
// 飞书卡片会自行补自定义回答表单，Telegram/微信只消费这份共享 selection，
// 缺这个入口用户就只能批准、无法提修改意见。补入口不是提权：回调仍走 owner 校验。
    if (pending.renderContext?.kind === "plan_approval") {
      // Bugfix: Feishu provider 会自行补自定义回答表单，但 Telegram/微信依赖共享 selection。
      // Plan approval 必须在这里补入口，避免非卡片渠道只能批准、无法提交修改意见。
      options.push({
        id: BOT_ELICITATION_CUSTOM_OPTION_ID,
        label: msg(locale, "elicitationCustomOption"),
      });
    }
// 多选没有“选完即提交”的信号，必须显式给 __submit__；
// 否则每次勾选都会被当成答案推进到下一题。单选则用“跳过”让未答也能前进。
    if (question?.multiSelect) {
      options.push({
        id: BOT_ELICITATION_SUBMIT_OPTION_ID,
        label: msg(locale, "elicitationSubmitOption"),
      });
// “跳过”的 id 内嵌本轮 token：id 稳定性只在“本轮”内成立，
// 跨轮必须失效，否则上一题的跳过按钮会被当成本题答案（INV-11）。
    } else if (question) {
      options.push({
        id: getPendingElicitationSkipOptionId(pending),
        label: msg(locale, "elicitationSkipOption"),
      });
    }
// selection.id 用 requestId + 题号：同一条 elicitation 的每道题有独立持久 id，
// clearPendingElicitationSelection 按前缀就能整组清理。token 只解决“旧按钮点新题”。
// token 由 taskId/runId/requestId/题号派生，题号一变旧 token 立即失效；它不参与投递幂等。
// 若把 token 拼进 requestId，重启后无法与 Agent 侧的 requestId 对齐。
    return {
      id: `elicitation-${pending.requestId}-${pending.currentQuestionIndex}`,
      token: getPendingElicitationSelectionToken(pending),
      title: formatBotElicitationTitle(pending, locale),
      action: "elicitation.respond",
      options,
    };
  }

// 生成一条 elicitation 消息（可能被适配器拆成多张卡/多条文本，故返回数组）。
// status=pending 停留在当前题；completed/cancelled 把题号推到末题，
// 让 UI 把终态理解为整份问卷的结果，而不是“还卡在某题”。
// 副作用：不落盘；仅 plan approval 补 schema，供重启后重建卡片。
  async function createElicitationReply(
    actor: BotActor,
    pending: BotPendingElicitation,
    locale: Locale | undefined,
    status: NonNullable<BotOutboundMessage["elicitation"]>["status"] = "pending",
  ): Promise<BotOutboundMessage[]> {
// 终态统一落到最后一题：若保留原题号，UI 会认为还有后续题可答，
// 任务结束后仍渲染可交互状态（INV-04 悬挂交互）。
    const currentQuestionIndex =
      status === "pending"
        ? pending.currentQuestionIndex
        : Math.max(0, pending.questions.length - 1);
    return createSelectionReply(actor, createBotElicitationSelection(pending, locale), locale, {
      locale,
      elicitation: {
        requestId: pending.requestId,
        taskId: pending.taskId,
        runId: pending.runId,
        currentQuestionIndex,
        questions: pending.questions,
        answers: pending.answers,
        status,
// 只在有展开标记时透传：undefined 与空数组语义等价，空数组只会给持久化 JSON 添噪声。
        ...(pending.expandedCustomAnswerQuestionIndexes?.length
          ? {
              expandedCustomAnswerQuestionIndexes: pending.expandedCustomAnswerQuestionIndexes,
            }
          : {}),
// schema 每次出站都重建：计划正文存在 renderContext 里；若只在首发携带，
// 后续卡片更新会退回通用问答卡，丢失计划内容。
        ...(createPendingElicitationSchema(pending)
          ? { schema: createPendingElicitationSchema(pending) }
          : {}),
      },
    });
  }

// 终态消息只带结果文案 + elicitation 元数据，不再附选项；
// 卡片渠道据此把交互卡原地改成结论卡，历史仍可回看（INV-04 成对清理）。
// [事务] 这里只组装不投递；投递由调用方完成，卡片与文本两条通道才能复用。
// 若在此处直接发送，中断后无法重放同一终态。
  function createCompletedElicitationOutbound(
    actor: BotActor,
    pending: BotPendingElicitation,
    locale: Locale | undefined,
    action: "accept" | "decline" | "cancel",
  ): BotOutboundMessage {
// cancel 与 decline 在协议层都表示“未提交”，只有 accept 代表用户真的答完了。
    const status = action === "cancel" ? "cancelled" : "completed";
    return createOutbound(
      actor,
      msg(locale, action === "accept" ? "elicitationSubmitted" : "elicitationCancelled"),
      undefined,
      {
        locale,
        elicitation: {
          requestId: pending.requestId,
          taskId: pending.taskId,
          runId: pending.runId,
          currentQuestionIndex: Math.max(0, pending.questions.length - 1),
          questions: pending.questions,
          answers: pending.answers,
          status,
          ...(createPendingElicitationSchema(pending)
            ? { schema: createPendingElicitationSchema(pending) }
            : {}),
        },
      },
    );
  }

// 按 requestId 精确清理 pending（INV-04）：只在 id 匹配时动手，
// 迟到的 elicitation_response 不能清掉“新一轮”的交互。
// [并发] 先删内存 selection 再落盘，读侧始终以 repo 为准。
  async function clearPendingElicitationForRequest(
    context: BotContextState,
    requestId: string,
  ): Promise<void> {
// 不匹配直接返回：当前 pending 已被后续请求替换，旧响应不能再改写任何字段。
    if (context.pendingElicitation?.requestId !== requestId) {
      return;
    }
// 先清 pendingSelectionsByContext：即使落盘失败，也不会留下“还能点到旧卡”的内存态。
    clearPendingElicitationSelection(context.pendingElicitation);
    await writeContext({ ...context, pendingElicitation: undefined }, false, context.activeTaskId);
  }

// 提交/取消问答的唯一收口：卡片回调、文本、结构化响应都汇聚到这里。
// [事务] 顺序：ownership → handledAt → respondElicitation → 写 handledAt → 清 pending → 广播；
// 前序任一步失败都不清 pending，让用户可重试，任务不会永久等待（INV-04）。
// [权衡] 三个入口共用一个收口，是为了让 handledAt 的写入顺序只有一份；
// 分开写会漂移成“某条路径先删 pending 再 respond”，重试就再也答不上。
  async function submitPendingElicitation(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    pending: BotPendingElicitation,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ): Promise<BotOutboundMessage[]> {
// INV-01/INV-04：先验归属再做副作用。actorKey 由创建交互的 actor 派生，
// 群内其他成员即使拿到 requestId 也不能代答。
    if (!isPendingElicitationOwnedByActor(pending, actor)) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
// 已处理直接回执，不再请求 Agent——这同时是回调重放的幂等闸门。
    if (pending.handledAt) {
      return [createOutbound(actor, msg(auth.locale, "elicitationHandled"))];
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
// respondElicitation 是业务确认点：返回 false 表示 Agent 侧已无此交互。
// [失败路径] 抛错时向上传播且 pending 保持原样，用户可重试。
    const submitted = await zcodeTaskService.respondElicitation({
      taskId: pending.taskId,
      workspacePath: auth.context.workspacePath,
      workspaceIdentity: auth.context.workspaceIdentity,
      runId: pending.runId,
      requestId: pending.requestId,
      action,
      content,
    });
// 与下面两行合看：ACK 之前不写 handledAt，ACK 之后才落“已处理”。
// 反序会让一次网络抖动永久关掉这次交互（INV-04）。
    // 修复原因：v4 resolveInteraction 才是业务确认点。若在 ACK 前写 handledAt，
    // 瞬时失败后的同一按钮重试会被误判为已处理，Agent 将永久停在等待用户输入。
// 先写 handledAt 而不是直接删除：让并发的第二次点击看到“已处理”，
// 避免同一请求被 respond 两次。
    const handledAt = Date.now();
    await writeContext({
      ...auth.context,
      pendingElicitation: { ...pending, handledAt },
    });
// 清 selection 与 handledAt 写在同一段之后：否则用户还能点开一张已提交的卡。
    clearPendingElicitationSelection(pending);
// 第二次写把 pending 置空，完成成对清理；writeContext 会按 activeTaskId 校验，
// 任务已切换时不会把空值写到新任务上。
    await writeContext({ ...auth.context, pendingElicitation: undefined });
// 广播只做 UI 增量刷新，内部吞掉失败，不影响提交结果。
    await broadcastTaskListChange(auth.context, pending.taskId, "elicitation_resolved", {
      requestId: pending.requestId,
    });
// submitted=false 表示 Agent 侧已无该交互：仍回“已处理”，但不启动 typing，
// 否则用户会以为模型还在生成。
    if (!submitted) {
      return [createOutbound(actor, msg(auth.locale, "elicitationHandled"))];
    }
// 只有 accept 会触发后续输出；取消/拒绝起 typing 会给出错误的进度暗示。
    if (action === "accept") {
      startTyping(auth.bot, actor, pending.taskId);
      // Bugfix: AskUserQuestion 只是在回复问题，不属于命令配置成功；这里保留原问答提交文案，避免误回 /status。
      return [createCompletedElicitationOutbound(actor, pending, auth.locale, action)];
    }
    // Bugfix: 取消/拒绝问答也应使用问答自己的结果文案，避免第三方 Bot 里出现无关的任务状态。
    return [createCompletedElicitationOutbound(actor, pending, auth.locale, action)];
  }

// advancePendingElicitation 推进到下一题，末题则整体提交并回执。
// 入参 answers 已是完整答案表（调用方已合并本题），这里只负责推进与回执。
// [资源] 每次推进都广播进度快照，Web/桌面据此保持选中态。
  async function advancePendingElicitation(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    pending: BotPendingElicitation,
    answers: BotPendingElicitation["answers"],
  ): Promise<BotOutboundMessage[]> {
// 末题即提交：content 由 buildBotElicitationContent 生成，
// 只有真正答过的题才进入 content，未答键不写空串（空串会被当成用户偏好）。
// 用 pending 而不是 nextPending 构造 content：nextPending 只是尚未落盘的中间态。
// 用 nextPending 可能把未确认的答案表一起提交。
    if (pending.currentQuestionIndex >= pending.questions.length - 1) {
      return submitPendingElicitation(
        auth,
        actor,
        { ...pending, answers },
        "accept",
        buildBotElicitationContent(pending, answers),
// 先落盘再广播：nextPending 是下一次点击的读取源；顺序反过来用户会点到旧题号。
      );
    }
    const nextPending: BotPendingElicitation = {
      ...pending,
      currentQuestionIndex: pending.currentQuestionIndex + 1,
      answers,
    };
    await writeContext({ ...auth.context, pendingElicitation: nextPending });
    // Bugfix: Bot 侧代选 AskUserQuestion 后，UI 只收到最终响应会停留在旧本地草稿。
    // 每次推进题号都同步当前题号和已选答案，让桌面/移动 Web 能保持同一选中态。
// 广播内部有超时降级（只 warn），必须如此：按钮回调要及时返回下一题，不能被人卡住。
    await broadcastPendingElicitationProgress(auth.context, nextPending);
    return createElicitationReply(actor, nextPending, auth.locale);
  }

// 处理结构化选项点击（卡片按钮 / Telegram callback 最终都归一到这里）。
// 返回值总是可直接投递的回复；无法处理时回 elicitationExpired，而不是空数组，
// 避免平台判定回调成功但用户毫无反馈。维护 INV-04 与 INV-11。
// pending 取自 auth.context：鉴权已保证 context 与 bot 匹配，这里不再重复查 config。
  async function handlePendingElicitationValue(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    value: string,
  ): Promise<BotOutboundMessage[]> {
// 本函数不落盘上下文：pending 的写入已在交互创建与推进处完成。
// 所以 pending 读的是 context 里的权威投影，与落盘值一致，不是本地草稿。
    const pending = auth.context.pendingElicitation;
// 任务必须仍是当前 activeTask：切任务后旧卡点击不能回答新任务的问题（INV-04）。
    if (!pending || pending.taskId !== auth.context.activeTaskId) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
// 归属失败按“已过期”回复，不暴露“存在但无权”，避免探测他人交互（INV-01）。
    if (!isPendingElicitationOwnedByActor(pending, actor)) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
// 题号取自 pending 而不是回调 payload：payload 里的题号可能已被推进。
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
// 解析 “<token> <value>” 形式：token 是渲染时写进按钮 payload 的本轮标识。
    const parsedValue = parseElicitationResponseValue(value);
// 微信没有结构化选项，选择是纯数字文本，无法携带 token，故跳过校验；
// 其余渠道强制比对本轮 token，防止上一轮按钮在新一轮才送达（INV-11）。
// [权衡] 微信端少一层防重放，仍由 taskId + ownership + selection 单次消费兜底。
    if (actor.provider !== "weixin") {
      const expectedToken = getPendingElicitationSelectionToken(pending);
      if (!parsedValue.token || parsedValue.token !== expectedToken) {
        // Bugfix: Telegram/飞书/Webhook 的旧按钮可能在新一轮 AskUserQuestion 后才送达。
        // 非微信通道必须带本轮短 token，避免把上一轮按钮编号误当成当前问题的答案。
        return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
      }
    }
// 跳过项以 __skip__:<token> 原样回传，必须在解析表单/选项之前拦截。
// 跳过不写入 answers，保证“未答”和“答了空”在协议上可区分。
    if (parsedValue.value === getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
// __form__: 是自定义表单的整包提交（INV-11）。表单只承载自定义输入，
// 平铺选项由按钮维护草稿，所以这里必须合并两者，否则空表单会清掉已勾选项。
// [失败路径] JSON 解析失败返回 []，随后重发当前题而不是提交空答案。
    const formValues = parseElicitationFormValues(parsedValue.value);
    if (formValues) {
      const answerKey = getElicitationAnswerKey(pending.currentQuestionIndex);
      const nextValues = mergeElicitationFormValues(
        question,
        readElicitationAnswerValues(pending, pending.currentQuestionIndex),
        formValues,
      );
// 合并结果为空说明用户既没勾选也没输入。
// 重发同一题是唯一不破坏草稿的选择。
      if (nextValues.length === 0) {
        return createElicitationReply(actor, pending, auth.locale);
      }
      // Bugfix: 飞书/Lark 平铺选项由按钮维护草稿，表单只负责提交和自定义输入。
      // 提交时需要合并当前 radio/checkbox 草稿和自定义输入，避免空表单把已选项覆盖掉。
      return advancePendingElicitation(auth, actor, pending, {
        ...pending.answers,
        [answerKey]: nextValues,
      });
    }
// 用 pendingSelectionsByContext 反查真实 option：按钮 payload 可能只是短序号，
// 真实 id 暂存在内存 selection 中（Telegram callback_data 64 字节限制）。
    const selectionOption = resolvePendingSelectionOption(
      actor,
      "elicitation.respond",
      parsedValue.value,
    );
    if (selectionOption?.id === getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
// 文本/序号都归一成 option.value；无法识别时保留原文本，作为自定义答案继续。
    const selectedValue = resolveElicitationQuestionValue(
      question,
      selectionOption?.id ?? parsedValue.value,
    );
// 无法识别的值按“重放”处理：重发当前题，绝不把未知文本写成答案。
    if (!selectedValue) {
      return createElicitationReply(actor, pending, auth.locale);
    }
// __submit__ 只出现在多选题，语义是“保留当前草稿并进入下一题”。
    if (selectedValue === BOT_ELICITATION_SUBMIT_OPTION_ID) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
// 自定义项是草稿态开关而非答案：展开后由文本/表单作答，
// 所以只翻转标记并重发卡片，绝不能写进 answers。
    if (selectedValue === BOT_ELICITATION_CUSTOM_OPTION_ID) {
      const nextPending = toggleElicitationCustomAnswerExpanded(pending);
      await writeContext({ ...auth.context, pendingElicitation: nextPending });
      await broadcastPendingElicitationProgress(auth.context, nextPending);
      return createElicitationReply(actor, nextPending, auth.locale);
    }
    const answerKey = getElicitationAnswerKey(pending.currentQuestionIndex);
// 多选 toggle 只改草稿，不触发 Agent；去重后写回，并额外广播快照，
// 否则桌面端会停留在旧勾选态。
    if (question.multiSelect) {
      const currentValues = readElicitationAnswerValues(pending, pending.currentQuestionIndex);
      const nextValues = currentValues.includes(selectedValue)
        ? currentValues.filter((item) => item !== selectedValue)
        : [...currentValues, selectedValue];
      const nextPending = {
        ...pending,
        answers: { ...pending.answers, [answerKey]: nextValues },
      };
// 写盘失败会让整次点击失败：用户可重试，不会出现“界面勾了、磁盘没勾”。
      await writeContext({ ...auth.context, pendingElicitation: nextPending });
      // Bugfix: 多选题在 Bot 里 toggle 后不会触发 ZCode Agent response，必须主动同步草稿给 UI。
      await broadcastPendingElicitationProgress(auth.context, nextPending);
      return createElicitationReply(actor, nextPending, auth.locale);
    }
// 单选即终选：直接调 advancePendingElicitation 推进（末题则提交），不再等额外确认。
    return advancePendingElicitation(auth, actor, pending, {
      ...pending.answers,
      [answerKey]: [selectedValue],
    });
  }

// 文本输入处理；返回 null 表示“这条消息不属于 elicitation”，主流程会继续
// 把它当普通任务输入投递。三态（null / [] / [msg]）是刻意的：
// 无 pending 时若返回空数组，会把用户的正常消息吞掉。
  async function handlePendingElicitationText(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    text: string,
  ): Promise<BotOutboundMessage[] | null> {
    const pending = auth.context.pendingElicitation;
// 无 pending 或任务已切换 → null 放行，让同一条消息继续走任务输入分支。
    if (!pending || pending.taskId !== auth.context.activeTaskId) {
      return null;
    }
    if (!isPendingElicitationOwnedByActor(pending, actor)) {
      return null;
    }
// 空白文本重发当前题，避免把空串写成答案。
    const value = text.trim();
    if (!value) {
      return createElicitationReply(actor, pending, auth.locale);
    }
// 文本形态的 skip id（含 token）也接受：微信没有按钮，用户只能复制该 id。
    if (value === getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
// answerKey 用题号字符串，与 UI 的 answer_<index> 约定一致。
    const answerKey = getElicitationAnswerKey(pending.currentQuestionIndex);
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
// 纯文本渠道的“跳过”只能靠菜单序号识别（选项数 + 1），且只在单选时生效，
// 否则多选的第 N 项会被误判成跳过。
// 刻意不按关键字（skip/next/跳过）识别：那些可能是模型给出的合法选项值。
    if (
      !question.multiSelect &&
      /^[1-9]\d*$/u.test(value) &&
      Number.parseInt(value, 10) === question.options.length + 1
    ) {
      // 修复原因：自由文本必须保留为用户数据；只有菜单显示的额外序号才是跳过，
      // 避免吞掉名为 skip/next/跳过/__skip__ 的合法选项或自定义答案。
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
// 多选文本按逗号/换行/顿号切分，逐项归一；includeSubmit:false 保证
// 文本里的 “submit” 只是普通答案，不会被当成提交信号。
    const values = question?.multiSelect
      ? value
          .split(/[,\n，、]/u)
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) =>
            resolveElicitationQuestionValue(question, item, {
              includeSubmit: false,
            }),
          )
      : [resolveElicitationQuestionValue(question, value, { includeSubmit: false })];
// 自由文本原样（已 trim）作为答案提交，不做别名改写，保证用户输入可追溯。
    return advancePendingElicitation(auth, actor, pending, {
      ...pending.answers,
      [answerKey]: values,
    });
  }

// 结构化响应入口（卡片 action / Webhook 回调）：适配器已翻译成 action + content。
// 与文本路径的区别是 requestId 由回调携带，可精确定位是哪一次交互。
  async function handleStructuredElicitationResponse(
    message: BotInboundMessage,
    response: BotStructuredElicitationResponse,
  ): Promise<BotOutboundMessage[]> {
// 结构化通道仍复用 message 的 botId/chatId 校验：回调 payload 本身不可信（INV-01）。
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
// requestId 必须等于当前 pending：同一任务可能连续多次 elicitation，
// 只校验 taskId 会把旧请求的答案写进新交互。
    const pending = auth.context.pendingElicitation;
    if (!pending || pending.requestId !== response.requestId) {
      return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
    }
// 归属校验与文本路径一致：requestId 泄露也不能替别人回答（INV-01）。
    if (!isPendingElicitationOwnedByActor(pending, message.actor)) {
      return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
    }
    return submitPendingElicitation(
      auth,
      message.actor,
      pending,
      response.action,
      response.content,
    );
  }

// Agent 发起 elicitation 时的投影入口：把 stream event 落成可交互的 pending 状态。
// [事务] 顺序：stopTyping → 组装 pending → 清旧 selection → 落盘 → 广播 → 投递。
// 副作用：写 repo、广播 bots:task、发 IM 消息（可能走临时交互卡）。
// 维护 INV-04（新交互替换旧交互）与 INV-11（选项 id 稳定）。
  async function handleElicitationRequest(
    bot: BotConfig,
    user: BotConfig,
    actor: BotActor,
    context: BotContextState,
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
    mentionedUserIds?: string[],
  ): Promise<void> {
// 先停 typing：任务已进入“等待用户输入”，继续显示正在输入会误导用户。
// 与终态处的 stopTyping 对称：只在确实需要用户输入时停止。
// 若不停，typing 计时器会与交互卡并存，用户以为模型还在写。
    const locale = await readMessageLocale();
    stopTyping(event.taskId);
// pending 是纯数据快照，可安全持久化；runId 取 traceId，同一 run 内 requestId 唯一。
    const pendingElicitation: BotPendingElicitation = {
      taskId: event.taskId,
      requestId: event.requestId,
      runId: event.traceId,
// origin 是 subagent 归属信息：广播与后续响应都靠它还原请求来源。
      // Bugfix：subagent 发起的 elicitation 必须保留 origin；否则 Bot 广播和后续响应
      // 无法还原请求归属，rebase 后只剩顶层 stream event 带 origin。
      ...(event.origin ? { origin: event.origin } : {}),
// actorKey 绑定发起交互的会话上下文，后续回答必须来自同一 actor（INV-01/INV-04）。
      actorKey: getActorContextKey(actor),
      currentQuestionIndex: 0,
      // 修复原因：ExitPlanMode 的协议问题和选项使用稳定英文；如果直接复用，中文 Bot 卡片会中英混杂。
      // Bot 在出站边界按 App locale 本地化整组审批文案，普通 AskUserQuestion 保持模型原文。
// 问题在出站边界本地化：plan approval 的协议枚举是英文，直接展示会中英混杂。
      questions: normalizeBotElicitationQuestions(event, locale),
      answers: {},
// renderContext 只存重建卡片所需的语义元数据（计划正文），不存渲染结果。
      // 修复原因：Feishu/Lark 会在自定义回答、完成和重启恢复时重建原卡片；
      // 只把 schema 作为首次发送参数会让后续更新丢失 plan 并退回通用 Question 卡片。
      ...(readBotElicitationRenderContext(event)
        ? { renderContext: readBotElicitationRenderContext(event) }
        : {}),
    };
    // Bugfix: Bot 原先只消费 permission_request，没有把 ZCode Agent 的
    // AskUserQuestion/elicitation_request 转成第三方可回答消息，任务会一直卡在等待用户输入。
// 替换旧 pending 前先清它的 selection：同一会话内存里只能有一份可点击选择，
// 否则旧卡按钮会被 resolve 到新请求上（INV-11）。
// 旧 pending 的 selection 必须在写新 pending 之前清掉，避免 resolve 串台。
    if (context.pendingElicitation) {
      clearPendingElicitationSelection(context.pendingElicitation);
    }
// [权衡] 先把 pending 挂到本地 context 快照再落盘：本函数后续生成回复要读它。
// writeContext 带 expectedTaskId，任务已切换时不会把这份投影写进磁盘。
    Object.assign(context, { pendingElicitation });
// 落盘失败会抛出：事件队列记 warn 不重试；用户看到卡已发但状态未持久化，重启即丢。
// 事件队列对这里只记 warn：交互状态丢失可恢复，不能让整条订阅退出。
    await writeContext({ ...context, pendingElicitation }, false, context.activeTaskId);
// 广播进度快照让桌面/移动 Web 同步进入问答态；内部超时降级，不阻塞 IM 投递。
    await broadcastPendingElicitationProgress(context, pendingElicitation);
// 返回数组可能包含多张卡（长问卷分段），必须逐条投递而不是只发第一条。
    for (const reply of await createElicitationReply(actor, pendingElicitation, locale)) {
      // 原因：临时交互卡绕过普通出站分支，曾丢失群任务和授权版本；选择传输方式前统一附加。
// 群内交互消息必须补 groupTaskId/groupCard：临时卡绕过普通出站分支，
// 缺这两项会丢失群授权版本，回调时无法通过 withAuthorizedContext 校验（INV-01）。
// plan approval 额外 @ 管理员：审批需要人决策，静默卡片容易被漏看。
// 缺 groupCard 时适配器无法携带授权版本，卡片回调会被判为过期。
      const scopedReply = context.group
        ? {
            ...reply,
            mentionedUserIds:
              pendingElicitation.renderContext?.kind === "plan_approval"
                ? adminAttention.mention(
                    actor,
                    bot.providerUserId,
                    `plan:${event.taskId}:${event.requestId}`,
                  )
                : mentionedUserIds,
            groupTaskId: context.activeTaskId!,
            groupCard: groupCardFor(actor, context),
          }
        : reply;
// 临时交互卡可原地更新，避免每推进一题就刷一条新消息；
// 普通消息是兜底通道，保证非飞书渠道拿到同一份内容。
      if (shouldUseTransientInteractionCard(bot, user)) {
        await upsertTransientInteractionCard(bot, actor, event.taskId, scopedReply);
      } else {
        await sendOutbound(bot, scopedReply);
      }
    }
  }

// 串行化 startTaskStream：启动恢复与首条输入可能同时触发订阅，
// 并发进入会各自读到“无订阅”而重复注册，导致同一段输出被投递两次。
// [并发] 同 key 排队执行；前一个失败被 catch，不会毒化后续调用。
  async function watchTaskStream(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    user: BotConfig,
    automation: boolean | string = false,
  ): Promise<void> {
    const key = taskStreamKey(context, actor);
// 取上一次调用的 promise 作为链尾；已结束的 promise 仍可 then，代价可忽略。
    const previous = watchStarts.get(key) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => startTaskStream(bot, actor, context, user, automation));
    watchStarts.set(key, pending);
    try {
      await pending;
// 只清自己登记的那条链：避免删掉后来者覆盖的链，从而放过一次重复订阅。
    } finally {
      if (watchStarts.get(key) === pending) watchStarts.delete(key);
    }
  }

// 建立一条任务流订阅：把 Agent 事件投影成 IM 回复/卡片/交互，并维护本轮结果状态。
// 生命周期由 streamSubscriptions 持有，dispose 置 disposed 并释放 hub 订阅（INV-12）。
// 副作用：repo 读写、广播、IM 发送、typing 定时器、飞书流式卡片请求。
// [资源] 句柄必须先登记，否则 stopTaskStream/disposeAll 找不到它，订阅会泄漏。
// [并发] 本函数可能被启动恢复、首条输入、重连三条路径调用，靠 watchTaskStream 串行。
  async function startTaskStream(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    user: BotConfig,
    automation: boolean | string = false,
  ): Promise<void> {
// 没有 activeTaskId 就没有订阅目标；静默返回，调用方已在上层校验。
    if (!context.activeTaskId) {
      return;
    }
// 恢复队列卡：重启或切任务后卡片可能停在旧状态，按持久化的 progress.status 追平，
// 避免用户看到“已执行”却仍显示排队中（INV-07）。
// [失败路径] 单张卡失败只 warn：卡片是展示层，不能因此挡住结果订阅。
// 只处理仍属于当前 activeTask 的输入，避免上一个任务的卡被复活。
    for (const [inputId, input] of Object.entries(context.group?.inputs ?? {})) {
      if (
        input.taskId !== context.activeTaskId ||
        !input.progress?.cardMessageId ||
        input.progress.cardStatus === input.progress.status
      )
        continue;
      await queueCards
        .update(
          JSON.stringify([
            bot.id,
            context.group!.chatId,
            context.activeTaskId,
            context.group!.authorizationId,
            inputId,
            context.group!.threadId,
          ]),
          input.progress.status,
        )
        .catch((error) => {
          botsLogger.warn(
            undefined,
            `restore queue card state failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
// 同一会话只允许一条订阅：重复订阅会把同一条 stream event 投递两遍，
// 群场景下表现为重复回复。
// 复用前要确认是同一 workspace + task + 会话，taskStreamKey 已包含这三者。
    const streamSubscriptionKey = taskStreamKey(context, actor);
    const existingSubscription = streamSubscriptions.get(streamSubscriptionKey);
    if (existingSubscription) {
// automation(id) 只登记 runId，不立即切轮：轮边界仍由 task_run_started 决定。
      if (automation)
        existingSubscription.automation(typeof automation === "string" ? automation : undefined);
      return;
    }
// 持久私聊同步：仅私聊、非自动化、provider 支持时常驻；
// 跨轮存在，因此必须用 privateBindingId 绑定，换绑后旧订阅立即失效。
    const persistentPrivate = !context.group && !automation && privateSyncSupported(bot);
// bindingId 在订阅建立时固化：任务切换会生成新 binding，旧订阅因此自动失效。
    const bindingId = context.privateBindingId;
    let automationPending = automation === true;
    let automationRun = Boolean(automation);
    const automationRuns = new Set<string>(typeof automation === "string" ? [automation] : []);
// 临时订阅默认允许 IM 审批入口；持久私聊默认关闭，
// 只有本轮确实由 IM 输入发起时，才在 task_run_started 打开。
    let imInteractionRun = !persistentPrivate;
    let privateDeliveryFailed = false;
    let privateCardDeliveryUnknown = false;
// 每次出站前重新校验授权：订阅是长生命周期的，bot 可能被停用/换绑、任务可能被切换，
// 捕获的 context 只是一份旧快照。
// [权衡] 每条消息多一次 readConfig/readState，换来停用后立即停止外发（INV-01/INV-05）。
// 返回 false 由调用方静默丢弃：授权撤销是预期状态，不是错误。
// 这条校验同时覆盖“bot 被删除”和“凭据轮换”两种情况。
    const isPrivateAuthorized = async (): Promise<boolean> => {
      if (!persistentPrivate) {
        if (context.group) return true;
        const currentBot = findBot(await repo.readConfig(), bot.id);
        return Boolean(
          currentBot?.enabled &&
          currentBot.provider === bot.provider &&
          currentBot.providerUserId === bot.providerUserId &&
          currentBot.credentialRef === bot.credentialRef,
        );
      }
// 持久私聊校验更严：除 bot 身份，还比对 recipient、workspace 白名单、activeTaskId、
// workspace key 与 privateBindingId。任一不匹配都说明订阅属于上一段绑定，
// 继续投递会把本轮结果发给错误的对象。
      const currentBot = findBot(await repo.readConfig(), bot.id);
      const latest = (await repo.readState()).bots[bot.id];
      const recipient =
        currentBot?.provider === "weixin" ? latest?.privateRecipientId : currentBot?.providerUserId;
      return Boolean(
        currentBot?.enabled &&
        currentBot.provider === bot.provider &&
        recipient === actor.providerUserId &&
        latest &&
        latest.privateBindingId === bindingId &&
        isWorkspaceAllowed(
          latest.workspaceId ?? getWorkspaceKey(latest.workspacePath, latest.workspaceIdentity),
          currentBot.allowedWorkspaces,
        ) &&
        latest?.activeTaskId === context.activeTaskId &&
        getWorkspaceKey(latest.workspacePath, latest.workspaceIdentity) ===
          getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      );
    };
// 远端 workspace 未连接时这里会抛 BotAdminRequiredError（INV-05），
// 因此订阅失败是显式错误，不会静默退化成本地 runtime。
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
// [并发] 群场景先读一次权威状态再订阅：旧会话未冷恢复时直接建订阅会触发重试风暴；
// getBotGroupTaskBlockReason 只读、不提交历史输入，这里只借它的读语义。
    if (context.group) {
      // Bug 原因：旧会话尚未冷恢复时建立结果订阅会耗尽重试；先读取权威状态，
      // 再监听未来事件，避免新请求执行结束后无人消费结果。这里不提交历史输入。
      await zcodeTaskService.getBotGroupTaskBlockReason?.({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      });
      // 启动恢复与首条输入可能并发，等待期间另一路已建立订阅时直接复用。
// 等待期间另一路（首条输入）可能已建立订阅；再查一次避免双订阅。
      if (streamSubscriptions.has(streamSubscriptionKey)) return;
    }
// 群内自动化（无 context.group）需要独立授权来源：automationGroupKey 指向群状态，
// authorizationId 作为后续投递必须匹配的授权版本。
    const automationGroupKey =
      actor.chatType === "group" && !context.group ? getBotConversationKey(actor) : null;
    const automationAuthorizationId = automationGroupKey
      ? (await repo.readState()).bots[automationGroupKey]?.group?.authorizationId
      : undefined;
// disposed 同时被卡片队列与事件队列读取，保证停止后不再有任何外发。
// 已入队的回调在执行前检查它，而不是依赖调用方不再调用。
    let disposed = false;
    let resultRunId = "";
    let resultSourceCommandId: string | undefined;
    let resultInputOrigin: "desktop" | "mobile" = "desktop";
    let resultPart = 0;
    let resultMentionedUserIds: string[] | undefined;
    const terminalRuns = new Set<string>();
// 本任务的唯一投递出口：授权校验、群字段补齐、deliveryId 生成只写一处，
// 避免不同分支各自拼装导致幂等键不一致。
    const sendTaskOutbound = async (
      targetBot: BotConfig,
      message: BotOutboundMessage,
    ): Promise<void> => {
// 群/持久私聊在 disposed 后必须完全静默：它们的目标是长期存在的会话，
// 任何迟到的终态消息都会让用户误以为任务还在跑。
      if (disposed && (context.group || persistentPrivate)) return;
      if (!(await isPrivateAuthorized())) return;
// privateDeliveryFailed 是“本轮放弃投递”的闸门，不是重试计数；
// 重试由 failedPrivateDeliveries 在终态统一登记，二者不能混用。
      if (privateDeliveryFailed) return;
// 微信发送凭据来自“用户给机器人发过消息”；缺失时发送必然失败。
// 提前短路并给可操作提示，而不是让每条消息各自失败一次（仅持久私聊）。
      if (
        persistentPrivate &&
        bot.provider === "weixin" &&
        !imInteractionRun &&
        !(await deps.credentialService.load(weixinContextKey(bot, actor.providerUserId)))
      ) {
        privateDeliveryFailed = true;
        const locale = await readMessageLocale();
        onDeliveryResult(
          bot,
          locale === "en-US"
            ? "Send a message to the bot in Weixin, then retry."
            : "请在微信给机器人发一条消息后重试。",
        );
        return;
      }
// 自动化群投递前复核 owner 与 authorizationId：群可能被换 owner、撤销或换绑，
// 旧订阅不能凭旧快照继续发言（INV-01）。
      if (automationGroupKey) {
        const current = (await repo.readState()).bots[automationGroupKey]?.group;
        const currentBot = findBot(await repo.readConfig(), bot.id);
        if (
          !current?.enabled ||
          !currentBot?.enabled ||
          current.ownerId !== currentBot.providerUserId ||
          current.authorizationId !== automationAuthorizationId
        )
          return;
      }
      try {
        await sendOutbound(
          targetBot,
// 群回复补齐投递上下文：threadId/rootMessageId 决定落在主聊天还是话题，
// groupCard 携带授权版本，replyToMessageId 把回复挂到触发消息下。
          context.group
            ? {
                ...message,
                groupTaskId: context.activeTaskId!,
// conversationThreadId 与 threadId 语义不同：前者决定会话路由，后者是消息归属。
                threadId: actor.threadId ?? context.group.threadId,
                rootMessageId: actor.rootMessageId ?? context.group.rootMessageId,
                conversationThreadId: actor.conversationThreadId,
                groupSourceCommandId: resultSourceCommandId,
                groupCard: groupCardFor(actor, context),
                replyToMessageId: actor.providerMessageId,
// undefined 表示不 @；空数组在某些适配器里等价于“显式不提醒”，语义不同。
                mentionedUserIds:
                  message.mentionedUserIds ??
                  (message.selection || resultPart === 0 ? resultMentionedUserIds : undefined),
// INV-07：deliveryId 由 bot/群/task/run/分段序号构成，不含正文——
// 同一分段重投必须得到同一 id 才能被去重；resultPart++ 保证分段互不相同。
// 选择卡不生成 deliveryId，它由卡片消息自身的幂等键管理。
                ...(!message.selection && resultRunId
                  ? {
                      deliveryId: createHash("sha256")
                        .update(
                          JSON.stringify([
                            bot.id,
                            context.group.chatId,
                            context.activeTaskId,
                            resultRunId,
                            resultPart++,
                          ]),
                        )
                        .digest("hex"),
                    }
                  : {}),
// 正文保持原样：来源走元数据，拼进正文会多出 Desktop/Mobile Web 标签。
                // 来源保留在关联元数据中；拼进正文会产生多余的 Desktop／Mobile Web 标签。
                text: message.text,
              }
            : message,
// 自动化再补一层 authorize：sendOutbound 在等待发送节流后会重新调用，
// 覆盖“排队期间群被停用”的窗口。
          automationGroupKey
            ? async () => {
                const current = (await repo.readState()).bots[automationGroupKey]?.group;
                const currentBot = findBot(await repo.readConfig(), bot.id);
                return Boolean(
                  current?.enabled &&
                  currentBot?.enabled &&
                  current.ownerId === currentBot.providerUserId &&
                  current.authorizationId === automationAuthorizationId,
                );
              }
            : undefined,
        );
// [失败路径] 非持久私聊把错误抛给事件队列（记 warn）；持久私聊则标记失败，
// 留到终态统一登记重试，避免一条失败消息拖垮整轮。
// 抛给队列而不是在此重试，保证事件顺序不被打乱。
      } catch (error) {
        if (!persistentPrivate) throw error;
        privateDeliveryFailed = true;
      }
    };
// 每轮重置的回复累积状态：parts 供 summary_changes 组装，buffer 供离散消息切分。
    let assistantParts: ZCodeAssistantMessagePart[] = [];
    let assistantReplyBuffer = "";
    let sentAnyAssistantReply = false;
    const assistantPartToolIds = new Set<string>();
    const toolCalls = new Map<string, BotReplyToolCallState>();
    const sentToolCallReplyIds = new Set<string>();
// 群与自动化固定用 summary_changes：群聊要“改了哪些文件”，自动化没有交互对象。
// 群内自动化同样走 summary_changes，避免逐条刷屏。
    const getMode = () =>
      context.group || automationRun
        ? "summary_changes"
        : normalizeBotReplyGranularity(bot.provider, user.replyMode);
// 流式卡片状态机：handle 为空表示尚未创建，segmentIndex 记录已封存的段；
// 这些变量只在本订阅内使用，不跨任务共享。
// 分段索引、块列表、句柄必须同步重置，否则封存后的续写会回写到旧 message_id。
    let streamingCardHandle: BotStreamingReplyCardHandle | null = null;
    let streamingCardSegmentIndex = 0;
    const streamingCardBlocks: StreamingCardTimelineBlock[] = [];
// status 只在本轮内流转：running → sealed/completed/error，不跨轮复用。
    let streamingCardStatus: "running" | "sealed" | "completed" | "error" = "running";
    let streamingCardLastUpdateAt = 0;
    let streamingCardConsecutiveFailures = 0;
    let streamingCardNextAttemptAt = 0;
    let streamingCardCircuitOpen = false;
    let streamingCardQueue: Promise<void> = Promise.resolve();
// 必须同时满足“streaming_card 模式 + 飞书系 + 适配器实现了创建与更新”，
// 否则退回普通消息，避免半实现能力导致静默丢消息（INV-09）。
    const supportsStreamingCardReply = () => {
      const adapter = providers[bot.provider];
      return (
        getMode() === "streaming_card" &&
        isFeishuBotProvider(bot.provider) &&
        Boolean(adapter?.createStreamingReplyCard) &&
        Boolean(adapter?.updateStreamingReplyCard)
      );
    };
    const buildStreamingToolSummaryTitle = (locale: Locale | undefined): string =>
      msg(locale, "streamingToolSummaries");
// 连续 chunk 追加到最后一个 message 块，否则卡片会按 token 数膨胀成上千个元素。
    const appendStreamingCardMessageChunk = (content: string): void => {
      if (!content) {
        return;
      }
      const lastBlock = streamingCardBlocks.at(-1);
      if (lastBlock?.type === "message") {
        lastBlock.text += content;
        return;
      }
      streamingCardBlocks.push({ type: "message", text: content });
    };
// 多段之间插空行：飞书卡片与普通文本都按段落渲染，粘在一起会失去可读性。
    const appendStreamingCardMessages = (messages: readonly string[]): void => {
      for (const message of messages.map((item) => item.trim()).filter(Boolean)) {
        const lastBlock = streamingCardBlocks.at(-1);
        if (lastBlock?.type === "message" && lastBlock.text.trim()) {
          lastBlock.text = `${lastBlock.text.trim()}\n\n${message}`;
        } else {
          streamingCardBlocks.push({ type: "message", text: message });
        }
      }
    };
    const hasStreamingCardMessageText = (): boolean =>
      streamingCardBlocks.some((block) => block.type === "message" && block.text.trim().length > 0);
// 工具块按出现顺序合并：同一工具只记一次，避免占满卡片元素预算。
    const appendStreamingCardTool = (toolId: string): void => {
      const existingBlock = streamingCardBlocks.find(
        (block) => block.type === "tools" && block.toolIds.includes(toolId),
      );
      if (existingBlock) {
        return;
      }
      const lastBlock = streamingCardBlocks.at(-1);
      if (lastBlock?.type === "tools") {
        lastBlock.toolIds.push(toolId);
        return;
      }
      streamingCardBlocks.push({ type: "tools", toolIds: [toolId] });
    };
// 把内部时间线块投影成适配器块；tools 块依赖 toolCalls 才有摘要，
// 尚未收到 update 的工具会被跳过，而不是渲染空块。
    const buildStreamingCardBlocks = (locale: Locale | undefined): BotStreamingReplyCardBlock[] => {
      const toolSummaryTitle = buildStreamingToolSummaryTitle(locale);
// 只展开“最后一个工具块”且仅在 running 态：历史块折叠，用户关注当前动作。
      const latestToolBlockIndex = streamingCardBlocks.reduce(
        (latestIndex, block, index) => (block.type === "tools" ? index : latestIndex),
        -1,
      );
      const blocks: BotStreamingReplyCardBlock[] = [];
// 逐块投影，块顺序即时间线顺序，不能重排：摘要卡的可读性依赖先后。
      for (const [index, block] of streamingCardBlocks.entries()) {
        if (block.type === "message") {
          const text = block.text.trim();
          if (text) {
            blocks.push({ type: "message", text });
          }
          continue;
        }
// [失败路径] 工具摘要为空时整块丢弃：渲染空工具块会让卡片出现无内容的折叠区。
        const summaries = block.toolIds
          .map((toolId) => toolCalls.get(toolId))
          .filter((toolCall): toolCall is BotReplyToolCallState => Boolean(toolCall))
          .map((toolCall) =>
            formatBotToolCallSummaryLine(toolCall, {
              workspacePath: context.workspacePath,
              locale,
            }),
          );
        if (summaries.length === 0) {
          continue;
        }
// 工具摘要延迟到渲染时计算：workspacePath/locale 调用时才确定，
// 提前格式化会把旧语言、旧路径固化进块里。
        blocks.push({
          type: "tools",
          title: toolSummaryTitle,
          summaries,
          expanded: streamingCardStatus === "running" && index === latestToolBlockIndex,
        });
      }
// 空卡片在飞书上表现为一条空白消息，用“处理中”兜底比不发更清楚。
      if (blocks.length === 0) {
        blocks.push({
          type: "message",
          text: msg(locale, "streamingWorking"),
        });
      }
      return blocks;
    };
// 流式卡片同步：节流 + 超时 + 指数退避 + 熔断（INV-09）。
// 触发点极多（每个 chunk/tool 事件），所以先做同步判断再入队。
// [并发] 所有请求经 streamingCardQueue 串行，防止并发 patch 同一 message_id 乱序覆盖。
    const syncStreamingCardReply = async (trigger: string, force = false): Promise<void> => {
// 结果未知时不更新卡片，但不停止事件处理：正文仍会走普通消息兜底。
// 这是 INV-09 的降级要求——卡片失败不能阻塞主回复。
      if (!supportsStreamingCardReply() || (persistentPrivate && privateCardDeliveryUnknown)) {
        return;
      }
      const now = Date.now();
      // Bugfix：旧实现只在成功后更新时间基准，Feishu 失败时每个 stream event 都会真实发请求；
      // force 路径还会绕过普通节流。失败退避和熔断必须先于 force 判断，避免单次 400 被放大成风暴。
// 熔断与退避判断必须先于 force：否则服务端持续 400 时，终态强制同步会形成请求风暴。
      if (streamingCardCircuitOpen || now < streamingCardNextAttemptAt) {
        return;
      }
// 普通更新的最小间隔节流；首帧（handle 为空）不节流，让用户尽快看到卡片。
      if (
        streamingCardHandle &&
        !force &&
        now - streamingCardLastUpdateAt < FEISHU_STREAMING_CARD_MIN_UPDATE_INTERVAL_MS
      ) {
        return;
      }
      const adapter = providers[bot.provider];
      const locale = await readMessageLocale();
      const state = {
        providerUserId: actor.providerUserId,
        locale,
        blocks: buildStreamingCardBlocks(locale),
        status: streamingCardStatus,
      };
// 适配器可把一份状态拆成多段，但段与段之间是“封存 + 新建”，不能复用 message_id。
      const states = adapter?.splitStreamingReplyCardStates?.(state) ?? [state];
// 入队而非直接 await：调用方是 stream 事件处理，排队保证同一张卡的 create/update
// 严格按调用顺序执行。队列内再校验 disposed/授权，排队期间任务可能已被停止或换绑。
      streamingCardQueue = streamingCardQueue
        .catch(() => undefined)
        .then(async () => {
          if (disposed || !(await isPrivateAuthorized())) return;
// operation 只用于日志与错误归因：区分 create 还是 update 失败，便于排查。
          let operation = streamingCardHandle ? "update" : "create";
// 请求级 AbortController 登记到集合：dispose 时统一 abort，
// 避免进程退出后仍有在途 HTTP 拖住事件循环（INV-12）。
          const requestController = new AbortController();
          streamingCardRequestControllers.add(requestController);
// 15s 超时兜底：不能依赖适配器自身的网络超时，卡住的请求会阻塞后续卡片更新。
          const timeoutId = setTimeout(() => {
            requestController.abort(new Error("Feishu streaming card request timed out."));
          }, FEISHU_STREAMING_CARD_REQUEST_TIMEOUT_MS);
          try {
// 从上次封存的段继续：前几段已展示不能重复创建，但每段前都重新校验授权。
            for (
              let index = Math.min(streamingCardSegmentIndex, states.length - 1);
              index < states.length;
              index += 1
            ) {
              if (disposed || !(await isPrivateAuthorized())) return;
              const segmentState = states[index]!;
              operation = streamingCardHandle ? "update" : "create";
              const request = !streamingCardHandle
                ? adapter?.createStreamingReplyCard?.(bot, segmentState, requestController.signal)
                : adapter?.updateStreamingReplyCard?.(
                    bot,
                    streamingCardHandle,
                    segmentState,
                    requestController.signal,
                  );
// 用 Promise.race 把 abort 变成拒绝：即使适配器忽略 signal，
// 这里也能及时退出并释放队列，不让单次调用悬挂。
              const result = await Promise.race([
                request,
                new Promise<never>((_, reject) => {
                  requestController.signal.addEventListener(
                    "abort",
                    () => reject(requestController.signal.reason),
                    { once: true },
                  );
                }),
              ]);
// 创建返回空 handle 属于静默失败（飞书可能 code=0 却不带 message_id）。
// 必须当异常处理：若当成成功推进 segmentIndex，这一段内容将永远没有落点。
// 空 handle 也要计入失败次数，否则会在同一个 chunk 上无限重试创建。
              if (!streamingCardHandle) {
                streamingCardHandle = result ?? null;
                if (!streamingCardHandle) {
                  // Bug 根因：飞书创建接口可能 code=0 却不返回 message_id。若把这种静默失败
                  // 当成成功推进 segmentIndex，未投递的中间段会被永久跳过；必须统一进入退避重试。
                  throw new Error("Feishu create streaming card returned no message_id.");
                }
              }
// 分段达成后主动置空 handle：后续块写新卡，已封存的卡保持只读。
              if (index < states.length - 1) {
                // 修复原因：当前卡片达到飞书元素预算后必须保留为 sealed 历史段，
                // 后续 block 只写入新卡片，不能把已展示内容再次发送或继续更新旧 message_id。
                streamingCardSegmentIndex = index + 1;
                streamingCardHandle = null;
              }
            }
// 成功一次即重置失败计数与退避：熔断只应针对持续失败，不惩罚偶发抖动。
            if (persistentPrivate) privateDeliveryFailed = false;
            streamingCardLastUpdateAt = Date.now();
            streamingCardConsecutiveFailures = 0;
            streamingCardNextAttemptAt = 0;
// [失败路径] 卡片失败不向调用方抛：它是 best-effort 展示，抛出去会中断
// task_complete/task_error 的清理与终态投递。
          } catch (error) {
            // Bugfix: 第三方卡片只是 best-effort 展示，超时/失败不能阻塞 task_complete、
            // task_error 或 typing 清理等生命周期事件。
// 区分“明确拒绝”和“结果未知”：后者不能在终态重试里直接重发，否则用户会收到重复内容。
            if (persistentPrivate) {
              privateDeliveryFailed = true;
              privateCardDeliveryUnknown = !isRecord(error) || error.deliveryRejected !== true;
            }
            streamingCardConsecutiveFailures += 1;
            const errorMessage = error instanceof Error ? error.message : String(error);
            onDeliveryResult(bot, errorMessage);
// 连续失败达阈值即熔断本轮后续更新，避免每个 stream 事件都触发一次注定失败的请求。
            if (
              streamingCardConsecutiveFailures >= FEISHU_STREAMING_CARD_FAILURE_CIRCUIT_THRESHOLD
            ) {
              streamingCardCircuitOpen = true;
              botsLogger.warn(
                undefined,
                `Feishu streaming card circuit opened task=${context.activeTaskId} trigger=${trigger} operation=${operation} failures=${streamingCardConsecutiveFailures}: ${errorMessage}`,
              );
// 退避基数 1s、按 2^(n-1) 增长；阈值 3 次即熔断，避免拖垮事件循环。
            } else {
              const retryDelayMs =
                FEISHU_STREAMING_CARD_FAILURE_BACKOFF_BASE_MS *
                2 ** (streamingCardConsecutiveFailures - 1);
              streamingCardNextAttemptAt = Date.now() + retryDelayMs;
              botsLogger.warn(
                undefined,
                `Feishu streaming card sync failed task=${context.activeTaskId} trigger=${trigger} operation=${operation} failures=${streamingCardConsecutiveFailures} retryDelayMs=${retryDelayMs}: ${errorMessage}`,
              );
            }
// 计时器与控制器登记必须成对清理：泄漏的 AbortController 会随任务数累积。
          } finally {
            clearTimeout(timeoutId);
            streamingCardRequestControllers.delete(requestController);
          }
        });
      await streamingCardQueue;
    };
// 封存当前卡片：交互卡出现前把已有正文定格成历史卡，之后续写会新建卡，
// 否则问题卡会夹在正文中间、后续内容又回写到旧卡。
// 没有 handle 说明本轮还没渲染出卡片，封存无事可做。
    const sealStreamingCardReply = async (): Promise<void> => {
      if (!streamingCardHandle) {
        return;
      }
      // 修复原因：阻塞交互前的 Agent 输出与交互后的 continuation 属于两个可读段落。
      // 旧实现继续复用同一 message_id，导致问题/Plan 卡夹在中间但后续正文回写到旧卡。
// 用 sealed 状态做最后一次强制同步，确保已累积的块都写进这张卡。
      streamingCardStatus = "sealed";
      await syncStreamingCardReply("seal", true);
      streamingCardHandle = null;
      streamingCardSegmentIndex = 0;
      streamingCardBlocks.length = 0;
      streamingCardStatus = "running";
      streamingCardLastUpdateAt = 0;
    };
// 离散消息模式的缓冲刷新：只在非 summary_changes 且非流式卡片时生效。
// force=true 用于工具调用/终态前，把不完整的句子也发出去。
    const flushAssistantReplyBuffer = async (force = false) => {
      if (
        getMode() === "summary_changes" ||
        supportsStreamingCardReply() ||
        !assistantReplyBuffer
      ) {
        return;
      }
// rest 必须留在 buffer：否则半个句子会被切断，下个 chunk 接不上。
      const extracted = extractBotAssistantResponseMessages(assistantReplyBuffer, force);
      assistantReplyBuffer = extracted.rest;
// 逐条发送而不是拼成一条：平台消息长度有限，已发送部分也不能因后续失败回滚。
      for (const text of extracted.messages) {
        sentAnyAssistantReply = true;
        await sendTaskOutbound(bot, createOutbound(actor, text));
      }
    };
// 单条 stream 事件的投影主函数。
// [并发] 只由 enqueueStreamEvent 串行调用，因此可以安全读改写本订阅的局部状态。
// shouldBroadcast=false 表示事件来自 mirror batch 转发，批量层已广播，避免重复推送。
    const handleStreamEventImpl = async (
      event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
      shouldBroadcast = true,
    ): Promise<void> => {
// dispose 后剩余事件直接丢弃：不再发请求、不再写状态（INV-12）。
      if (disposed) return;
// mirror batch 是共享 host/远控下 UI 收到的事件形态，必须展开成裸事件走同一套投影，
// 否则 Bot 侧会出现“UI 有流式回复、IM 完全没消息”。
// 展开时传 shouldBroadcast=false：批量广播已在上层完成，否则同一事件会推送两次。
      if (event.type === "task_stream_mirror_batch") {
        if (shouldBroadcast) {
          await broadcastTaskStreamEvent(context, event);
        }
        // Bugfix: 共享 host / 远控下 UI 收到的是 workspace 级 mirror batch。
        // 旧逻辑只识别裸 stream event，导致 UI 正常流式显示但 Bot channel 没有任何可发送回复。
        for (const op of event.ops) {
          if (op.kind === "stream_event") {
            await handleStreamEvent(op.event, false);
          }
        }
        return;
      }
// 自动化订阅只消费指定 run 的事件：同一 workspace 可能有其他任务，
// 不过滤会把别人的输出发到这个群。
// 过滤依据同时接受 inputId 与 traceId：不同来源的事件携带字段不同。
      if (
        typeof automation === "string" &&
        !persistentPrivate &&
        event.traceId !== automation &&
        event.inputId !== automation
      )
        return;
// 持久私聊的 run 追踪：resultRunId 决定哪些事件属于本轮，
// terminalRuns 防止重放/订阅重叠导致终态被二次投递。
// [资源] 只保留最近 128 个，避免常驻订阅无限增长。
      if (persistentPrivate) {
        if (!(await isPrivateAuthorized())) return;
        const runId = event.inputId ?? event.traceId;
// task_run_started 是新一轮的唯一起点：在这里重置全部轮内状态，
// 否则上一轮的 parts/卡片句柄会串到本轮。
        if (event.type === "task_run_started") {
// 重复 started 不清状态：重连/重放时它可能就是当前轮的同一个起点。
          if (runId && (terminalRuns.has(runId) || resultRunId === runId)) return;
          resultRunId = runId ?? "";
          privateDeliveryFailed = false;
          privateCardDeliveryUnknown = false;
          user = findBot(await repo.readConfig(), bot.id) ?? user;
          resultSourceCommandId = event.inputId;
          automationRun =
            automationRuns.delete(runId ?? "") ||
            automationRuns.delete(event.traceId) ||
            automationPending;
          automationPending = false;
          // 桌面/手机轮次只能同步输出，不能凭常驻订阅增加 IM 审批入口。
// 只有 IM 发起的 run 才允许弹审批/问答卡；桌面/手机发起的 run 只同步输出，
// 避免 Bot 越权成为审批入口（INV-01）。
          imInteractionRun = privateImTraces.has(
            JSON.stringify([streamSubscriptionKey, event.traceId]),
          );
// 轮内状态整体归零：工具表、已发送集合、卡片句柄，任何残留都会让本轮的
// 摘要或幂等判断引用上一轮数据。
          assistantParts = [];
          assistantReplyBuffer = "";
          sentAnyAssistantReply = false;
          assistantPartToolIds.clear();
          toolCalls.clear();
          sentToolCallReplyIds.clear();
          streamingCardHandle = null;
          streamingCardBlocks.length = 0;
          streamingCardSegmentIndex = 0;
          streamingCardStatus = "running";
          streamingCardLastUpdateAt = 0;
          streamingCardConsecutiveFailures = 0;
          streamingCardNextAttemptAt = 0;
          streamingCardCircuitOpen = false;
        } else {
// runId 缺失时不能一律丢事件：部分事件只带 traceId。
// 但已有 resultRunId 时再用“无 runId”兜底，会把别轮内容混进来。
          if (runId && terminalRuns.has(runId)) return;
          if (!resultRunId && runId) resultRunId = runId;
          if (resultSourceCommandId && event.inputId && resultSourceCommandId !== event.inputId)
            return;
        }
// 终态记录发生在业务处理之前：即使后续投递抛错，同一终态也不会再投一次。
        if (event.type === "task_complete" || event.type === "task_error") {
          if (runId) terminalRuns.add(runId);
          // continuous 不重放旧轮；有界保留重复终态保护。
          if (terminalRuns.size > 128) terminalRuns.delete(terminalRuns.values().next().value!);
        }
// 非 IM 交互轮不处理 permission/elicitation：入口直接留给 UI，与 imInteractionRun 配套。
        if (
          !imInteractionRun &&
          (event.type === "permission_request" || event.type === "elicitation_request")
        )
          return;
      }
// 群场景每条事件都重新读权威状态：群可能被停用/换 owner/切任务，
// 旧 context 只是快照，不能作为投递依据（INV-01）。
      if (context.group) {
        const latest = (await repo.readState()).bots[getBotStateKey(context)];
        const currentBot = findBot(await repo.readConfig(), bot.id);
        if (
          !latest?.group?.enabled ||
          latest.activeTaskId !== context.activeTaskId ||
          latest.group.ownerId !== currentBot?.providerUserId ||
          !currentBot.enabled
        )
          return;
        // 停止续接后旧输入可能迟到；不能用它覆盖新轮的缓存、表情或投递目标。
// 停止续接后旧输入的事件可能迟到：若允许它们改写 actor/mention/投递目标，
// 新一轮回复会被挂到旧消息下。
        if (
          latest.group.threadId &&
          resultSourceCommandId &&
          event.inputId &&
          event.type !== "task_run_started" &&
          event.inputId !== resultSourceCommandId
        )
          return;
// 群终态键优先 inputId，其次 traceId，最后 resultRunId：
// 三者来源不同，统一成一把键才能覆盖重放事件。
        if (event.type === "task_complete" || event.type === "task_error") {
          const terminalKey = event.inputId ?? event.traceId ?? resultRunId;
          if (terminalKey && terminalRuns.has(terminalKey)) return;
          if (terminalKey) terminalRuns.add(terminalKey);
        }
// 输入被丢弃/拒绝/会话重启：必须把用户原消息的表情改成对应终态，
// 否则用户一直看到“排队中”，误以为还会执行（INV-04 的回执侧）。
        if (event.type === "turn_steer_status" && event.status !== "drained") {
          for (const id of event.pendingInputIds ?? []) {
            const input = latest.group.inputs?.[id];
            if (!input || input.taskId !== context.activeTaskId) continue;
            await updateGroupInputReaction(
              bot,
              context,
              input.source.messageId,
              event.reason === "session_resumed" ? "discarded" : "cancelled",
            );
            // 话题不再提供排队/Steer 交互；旧运行丢弃事件只更新原输入状态与表情。
// 话题模式不再提供排队/Steer 交互，只更新表情与队列卡；再发一条丢弃通知会刷屏。
            if (latest.group.threadId) continue;
            const locale = await readMessageLocale();
            const text =
              event.reason === "session_resumed"
                ? locale === "en-US"
                  ? "Queued input was discarded after runtime restart; it was not executed."
                  : "排队输入已在运行时重启后丢弃，未执行。"
                : locale === "en-US"
                  ? "Queued input was removed or rejected; it will not execute."
                  : "排队输入已删除或被拒绝，不会执行。";
            const inputActor: BotActor = {
              ...actor,
              providerUserId: input.source.senderId,
              providerMessageId: input.source.messageId,
              mentionedBot: input.source.mentionedBot,
              threadId: input.source.threadId ?? context.group.threadId,
              rootMessageId: input.source.rootMessageId ?? context.group.rootMessageId,
              conversationThreadId: context.group.threadId ?? null,
            };
            await sendOutbound(bot, {
              ...createOutbound(inputActor, text),
              groupTaskId: context.activeTaskId!,
              groupCard: groupCardFor(inputActor, context),
              replyToMessageId: input.source.messageId,
// 通知幂等键由 inputId + status + reason 决定，同一输入的重复事件不会重复发消息（INV-07）。
              deliveryId: createHash("sha256")
                .update(`${id}:${event.status}:${event.reason}`)
                .digest("hex"),
            });
          }
          return;
        }
        if (event.type === "task_run_started") resultInputOrigin = event.inputOrigin ?? "desktop";
// 用本轮可信输入还原 actor：谁触发的这轮，回复就 @ 谁。
// 不能用群 owner 或“最近发言者”猜测，否则桌面触发的结果会被归到群主名下。
        if (event.type === "task_run_started" || event.inputId) {
          const source = event.inputId ? latest.group.inputs?.[event.inputId]?.source : undefined;
          // 按本轮可信输入解析，不能把无来源的桌面结果或重试归给群 owner/最近发言者。
          const isTopicReply = !!(source?.threadId ?? latest.group.threadId);
// 提及集合只取本轮输入发送者；话题里还要求 mentionedBot，避免把路过发言者拉进通知。
          resultMentionedUserIds = source
            ? [
                ...new Set(
                  (source.messages ?? [source])
                    .filter((item) => !isTopicReply || item.mentionedBot === true)
                    .map((item) => item.senderId),
                ),
              ]
            : undefined;
// 提及集合为空时置 undefined：空数组在适配器侧等价于“静默”，语义不同。
          if (!resultMentionedUserIds?.length) resultMentionedUserIds = undefined;
          actor = {
            ...actor,
            providerUserId: source?.senderId ?? latest.group.ownerId,
            displayName:
              source?.senderName ?? (resultInputOrigin === "mobile" ? "Mobile Web" : "Desktop"),
            providerMessageId: source?.messageId,
            mentionedBot: source?.mentionedBot,
            threadId: source?.threadId ?? latest.group.threadId,
            rootMessageId: source?.rootMessageId ?? latest.group.rootMessageId,
            conversationThreadId:
              source?.threadId && source.threadId !== latest.group.threadId
                ? (latest.group.threadId ?? null)
                : undefined,
          };
// initiatorId 只用于展示与审计，不参与后续授权判定（INV-01）。
          context.group = { ...latest.group, initiatorId: source?.senderId };
        }
// 新一轮开始：给触发消息打 working 表情、重置分段计数与缓冲，并把 context 落盘，
// 保证重启后仍知道本轮由哪条输入发起。
        if (event.type === "task_run_started") {
          await updateGroupInputReaction(bot, context, actor.providerMessageId, "working");
          resultRunId = event.inputId ?? event.traceId;
          resultSourceCommandId = event.inputId;
          resultPart = 0;
          assistantParts = [];
          assistantReplyBuffer = "";
          sentAnyAssistantReply = false;
          assistantPartToolIds.clear();
          toolCalls.clear();
          sentToolCallReplyIds.clear();
          await writeContext(context, false, context.activeTaskId);
        }
      }
// 兜底 runId 只在群场景补：私聊已由持久私聊分支维护 resultRunId。
// 缺它会让分段 deliveryId 退化成不带 run 的哈希，重放时可能撞车。
      if (context.group && !resultRunId) {
        resultRunId = event.inputId ?? event.traceId;
        resultSourceCommandId = event.inputId;
      }
// 广播原始事件是 UI 流式显示的唯一来源，与 IM 投递互不依赖。
      if (shouldBroadcast) {
        await broadcastTaskStreamEvent(context, event);
      }
      // Bugfix: 第三方默认回复需要随 AssistantMessageResponse 流式发送；
      // 但 /status Progress 仍然要独立缓存，避免受发送颗粒度影响。
// 进度缓存与发送模式无关：/status 在任何模式下都要看到最近一段输出。
      updateLiveStatusProgress(event);
// 助手正文先累积到 parts（所有模式都要），再按渠道决定流式卡片/缓冲发送/留给终态摘要。
      if (event.type === "agent_message_chunk") {
        assistantParts = appendAssistantMessagePart(assistantParts, {
          type: "content",
          content: event.content,
        });
// 卡片模式 chunk 直接进块并同步，不写 reply buffer，避免同一段文本发送两次。
// 同一 chunk 若既进卡片又进 buffer，会重复发送。
        if (supportsStreamingCardReply()) {
          appendStreamingCardMessageChunk(event.content);
          await syncStreamingCardReply(event.type, false);
          return;
        }
        if (getMode() !== "summary_changes") {
          assistantReplyBuffer += event.content;
          // 第三方平台消息是离散气泡；formatter 负责把当前 buffer 按长度约束拆成可发送消息。
          await flushAssistantReplyBuffer(false);
        }
        return;
      }
// 思考内容不参与 reply buffer：第三方渠道只应看到最终答案，避免泄露草稿推理。
      if (event.type === "agent_thought_chunk") {
        assistantParts = appendAssistantMessagePart(assistantParts, {
          type: "thought",
          content: event.content,
        });
      }
// 工具调用先落 toolCalls 表（下方统一更新），这里只处理块/分段边界。
      if (event.type === "tool_call" || event.type === "tool_call_update") {
        if (supportsStreamingCardReply()) {
          appendStreamingCardTool(event.toolId);
        }
        if (!supportsStreamingCardReply()) {
          await flushAssistantReplyBuffer(true);
        }
// tool_call_update 可能先于 tool_call 到达：补一个 tool-call part 边界，
// 与 UI latestPart 的划分保持一致。
        // Bugfix: summary_changes 完成消息需要参考 UI latestPart。
        // tool_call_update 可能在缺少 tool_call 首帧时先到，需像 UI 一样补一个 tool-call part 边界。
        if (!assistantPartToolIds.has(event.toolId)) {
          assistantPartToolIds.add(event.toolId);
          assistantParts = appendAssistantMessagePart(assistantParts, {
            type: "tool-call",
            toolId: event.toolId,
          });
        }
      }
// 工具状态表同时服务摘要行与卡片工具块，更新一次两处受益。
      updateBotReplyToolCalls(toolCalls, event);
      if (event.type === "tool_call" && supportsStreamingCardReply()) {
        await syncStreamingCardReply(event.type, true);
      }
      if (event.type === "tool_call_update" && supportsStreamingCardReply()) {
        await syncStreamingCardReply(event.type, isBotToolCallReplyTerminal(event.status));
      }
// assistant_toolcalls_changes 下每个工具终态单独发一条；
// sentToolCallReplyIds 保证同一工具只发一次（update 可能多次）。
      if (
        event.type === "tool_call_update" &&
        getMode() === "assistant_toolcalls_changes" &&
        isBotToolCallReplyTerminal(event.status) &&
        !sentToolCallReplyIds.has(event.toolId)
      ) {
        const toolCall = toolCalls.get(event.toolId);
        if (toolCall) {
          sentToolCallReplyIds.add(event.toolId);
          sentAnyAssistantReply = true;
          await sendTaskOutbound(
            bot,
            createOutbound(
              actor,
              formatBotToolCallReply(toolCall, {
                workspacePath: context.workspacePath,
                locale: await readMessageLocale(),
              }),
            ),
          );
        }
      }
// 权限请求：先封存正文卡、停 typing，保证问题卡独立出现。
// 权限请求必须先停 typing，否则用户以为模型仍在执行。
      if (event.type === "permission_request") {
        const locale = await readMessageLocale();
        stopTyping(event.taskId);
// 封存在广播之前：广播会让 UI 立刻切到问题卡，正文未封存就会错位。
        await sealStreamingCardReply();
        await broadcastTaskListChange(context, event.taskId, "permission_request", {
          permissionRequest: event,
        });
        // Bugfix: UI 会把 ZCode Agent 原始权限选项规整成“允许/始终允许/拒绝”的固定顺序和文案；
        // 机器人之前直接展示 provider 原始英文 name，还额外加取消按钮，导致同一个权限请求在飞书和 UI 看起来不一致。
// 选项归一成固定顺序与文案，和 UI 一致；不透传 provider 原始 name，
// 否则同一个请求在飞书和 UI 里看起来是两件事。
        const permissionOptions = sortBotPermissionOptions(event.options);
        const permissionSelection: SelectionPrompt = {
          id: `permission-${event.requestId}`,
          title: formatBotPermissionRequestSummary(event, {
            locale,
            workspacePath: context.workspacePath,
          }),
          action: "permission.respond",
          showCancel: false,
// 按钮 id 用命令形式携带 requestId/optionId，复用群命令鉴权，不再引入第二套回调协议。
// 拒绝项用 /deny，其余用 /approve + optionId，解析时无需再查映射表。
          options: permissionOptions.map((option) => {
            const isDenyOption = isBotPermissionRejectOption(option);
            return {
              id: isDenyOption
                ? `/deny ${event.requestId}`
                : `/approve ${event.requestId} ${option.optionId}`,
              label: formatBotPermissionOptionLabel(option, locale),
              description: formatBotPermissionOptionDescription(option, event, locale),
            };
          }),
        };
// Telegram callback_data 限 64 字节，真实 requestId+optionId 可能超限；
// 按钮只回传短序号，映射表暂存到 pendingPermissionOptions。
        // Bugfix: Telegram callback_data 只有 64 字节，真实 toolCallId/requestId 可能过长。
        // 因此按钮只回传短序号，真实 requestId/optionId 暂存在当前 bot context 中再解析。
// 映射表必须持久化：回调可能在新进程或重连后到达，内存 Map 不可靠。
// 每条选项都要保存 response：回调解析需要原始响应体，而不是再向 Agent 查询。
        const pendingPermissionOptions = permissionOptions.map((option) => {
          const isDenyCommand = isBotPermissionRejectOption(option);
          return {
            requestId: event.requestId,
            optionId: option.optionId,
            command: isDenyCommand ? ("deny" as const) : ("approve" as const),
            label: formatBotPermissionOptionLabel(option, locale),
            response: option.response,
          };
        });
// 先写内存后落盘，与 elicitation 的写法一致，便于同一函数内继续读取映射表。
        Object.assign(context, { pendingPermissionOptions });
        await writeContext({ ...context, pendingPermissionOptions }, false, context.activeTaskId);
// 选择卡也要带群 @：权限请求需要人决策，静默卡片容易被漏看。
        const [permissionReply] = await createSelectionReply(
          actor,
          permissionSelection,
          await readMessageLocale(),
        );
        if (permissionReply) {
// 临时卡路径同样要补 groupTaskId/groupCard：飞书群配置归一化后也走这条分支。
          if (shouldUseTransientInteractionCard(bot, user)) {
            // 原因：Feishu 群配置归一化后也会走临时卡分支，不能因此跳过群卡授权字段。
            await upsertTransientInteractionCard(
              bot,
              actor,
              event.taskId,
              context.group
                ? {
                    ...permissionReply,
                    mentionedUserIds: adminAttention.mention(
                      actor,
                      bot.providerUserId,
                      `permission:${event.taskId}:${event.requestId}`,
                    ),
                    groupTaskId: context.activeTaskId!,
                    groupCard: groupCardFor(actor, context),
                  }
                : permissionReply,
            );
          } else {
// 普通通道走 administratorReply：它会 @ 群管理员，失败时还能降级为普通消息。
            await sendTaskOutbound(
              bot,
              context.group
                ? administratorReply(
                    actor,
                    bot,
                    `permission:${event.taskId}:${event.requestId}`,
                    permissionReply,
                  )
                : permissionReply,
            );
          }
        }
        return;
      }
// 封存当前卡后由 handleElicitationRequest 负责 pending 落盘与投递；
// 两种交互共用「先 sealStreamingCardReply 切段、再出新卡」的节奏，避免旧卡被回填。
      if (event.type === "elicitation_request") {
        await sealStreamingCardReply();
        await handleElicitationRequest(bot, user, actor, context, event, resultMentionedUserIds);
        return;
      }
// Agent 侧已自行解决交互（例如 UI 已回答）：只清本地 pending，不再向 IM 发消息。
      if (event.type === "elicitation_response") {
        await clearPendingElicitationForRequest(context, event.requestId);
        await broadcastTaskListChange(context, event.taskId, "elicitation_resolved", {
          requestId: event.requestId,
        });
        return;
      }
// 终态：先做可观测回执（表情/typing/悬挂交互），再广播，最后投递正文。
// 这里没有跨仓事务，顺序按“越靠前越必须完成”排列，避免用户看到永久进行中。
// 表情、typing、悬挂交互都属于“用户可见的进行中”，必须在广播前收尾。
      if (event.type === "task_complete" || event.type === "task_error") {
        if (context.group) {
          await updateGroupInputReaction(
            bot,
            context,
            actor.providerMessageId,
            event.type === "task_error"
              ? "failed"
              : /stop|cancel|interrupt|abort/iu.test(event.stopReason)
                ? "stopped"
                : "done",
          );
        }
// 清理本轮 trace 与全局表：这些是跨任务共享的索引，不清理会造成内存泄漏与误判。
// privateImTraces 是“本轮是否由 IM 发起”的跨函数索引，必须随终态删除。
        privateImTraces.delete(JSON.stringify([streamSubscriptionKey, event.traceId]));
        runningTasks.delete(event.taskId);
        liveStatusProgressByTaskId.delete(event.taskId);
        stopTyping(event.taskId);
// 任务结束时仍挂着 pending，说明用户没答完：必须成对清理，
// 否则重启后 UI 会显示一个永远不会被回答的问题（INV-04）。
        if (context.pendingElicitation?.taskId === event.taskId) {
          clearPendingElicitationSelection(context.pendingElicitation);
          await writeContext(
            { ...context, pendingElicitation: undefined },
            false,
            context.activeTaskId,
          );
        }
// 属于本任务的临时交互卡要改成无控件终态；留在可点击状态只会让用户点到“已过期”。
// transientInteractionCards 以 actor key 索引，删除前要确认 taskId 相同。
        const transientCard = transientInteractionCards.get(getActorContextKey(actor));
        if (transientCard?.taskId === event.taskId) {
          const pendingElicitation = context.pendingElicitation;
          await finalizeTransientInteractionCard(
            actor,
            pendingElicitation
              ? createCompletedElicitationOutbound(
                  actor,
                  pendingElicitation,
                  await readMessageLocale(),
                  "cancel",
                )
              : createOutbound(
                  actor,
                  event.type === "task_error"
                    ? msg(await readMessageLocale(), "taskFailed", {
                        message: event.error,
                      })
                    : msg(await readMessageLocale(), "received"),
                ),
          );
        }
// 终态广播前重试读取 meta：避免状态/摘要先旧后新地跳一次。
        // Bugfix: ZCode Agent 终态事件可能先于 task index/meta 落盘广播到 Bots。
        // 如果这里立刻用旧 meta 更新 sidebar，随后列表再刷新到终态 meta，会出现状态/摘要跳一下。
        // 因此终态广播前短重试读取一次稳定 meta，尽量用同一帧完成 UI 增量更新。
// 读取失败按 null 处理：没有 meta 也要广播终态，UI 至少能停止 loading。
        const completedTask = await readTerminalTaskMeta(context, event.taskId, event.type).catch(
          () => null,
        );
        await broadcastTaskListChange(
          context,
          event.taskId,
          event.type === "task_error" ? "error" : "completed",
          {
            ...(completedTask ? { task: completedTask } : {}),
            ...(event.type === "task_error" ? { error: event.error } : {}),
          },
        );
// 临时订阅在终态后自毁：无常驻必要，也避免 streamSubscriptions 无限增长（INV-12）。
        if (!context.group && !persistentPrivate) {
          streamSubscriptions.get(streamSubscriptionKey)?.dispose();
          streamSubscriptions.delete(streamSubscriptionKey);
        }
// 任务失败：优先把错误写进流式卡片，保留用户已看到的正文；没有正文时补失败文案。
// 失败分支先尝试卡片：用户已经看到的正文不应在报错时整段消失。
        if (event.type === "task_error") {
          if (supportsStreamingCardReply()) {
            streamingCardStatus = "error";
            if (!hasStreamingCardMessageText()) {
              appendStreamingCardMessages([
                msg(await readMessageLocale(), "taskFailed", {
                  message: event.error,
                }),
              ]);
            }
            await syncStreamingCardReply(event.type, true);
            return;
          }
          await sendTaskOutbound(
            bot,
            createOutbound(
              actor,
              msg(await readMessageLocale(), "taskFailed", {
                message: event.error,
              }),
            ),
          );
          return;
        }

// 群内被停止的任务不主动发“已完成”：停止通知会诱发其他机器人接着回复，
// 表情与终态广播已足够表达结果。
        if (context.group && /stop|cancel|interrupt|abort/iu.test(event.stopReason)) {
          // 停止通知会触发群内其他机器人继续回复；主聊天与话题统一静默，前面的状态清理仍保留。
          return;
        }
// 完成时读任务快照：change summary 只存在于 meta，流事件不带文件变更列表。
        const mode = getMode();
        const locale = await readMessageLocale();
        const completedSnapshot = await zcodeTaskService
          .getTaskSnapshot({
            taskId: event.taskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          .catch(() => null);
        const latestTurnChangeSummary = readLatestAssistantTurnChangeSummary(completedSnapshot);
// 卡片模式把变更摘要追加成新的消息块，再以 completed 状态强同步。
// 变更摘要作为新块追加：它是本轮输出的一部分，不能覆盖前面已渲染的正文。
        if (supportsStreamingCardReply()) {
          const changeSummaryMessages = formatBotAssistantReplyBlocks(
            createAssistantReplyBlocks([], new Map(), mode, latestTurnChangeSummary),
            {
              workspacePath: context.workspacePath,
              locale,
            },
          );
          if (changeSummaryMessages.length > 0) {
            appendStreamingCardMessages(changeSummaryMessages);
          }
          streamingCardStatus = "completed";
          await syncStreamingCardReply(event.type, true);
          sentAnyAssistantReply = true;
          return;
        }
// 非卡片模式：summary_changes 用整轮 parts 组装，其他模式只补一段变更摘要。
// 非卡片模式下摘要单独成消息：正文已流式发出，再拼回去会重复。
        let replyMessages: string[] = [];
        if (mode === "summary_changes") {
          const replyBlocks = createAssistantReplyBlocks(
            assistantParts,
            toolCalls,
            mode,
            latestTurnChangeSummary,
          );
          replyMessages = formatBotAssistantReplyBlocks(replyBlocks, {
            workspacePath: context.workspacePath,
            locale,
          });
        } else {
          await flushAssistantReplyBuffer(true);
          const changeSummaryBlocks = createAssistantReplyBlocks(
            [],
            new Map(),
            mode,
            latestTurnChangeSummary,
          );
          replyMessages = formatBotAssistantReplyBlocks(changeSummaryBlocks, {
            workspacePath: context.workspacePath,
            locale,
          });
        }
// 无内容可发：话题里未 @ 机器人的续聊允许模型沉默，不能再用“任务已完成”抢答；
// 其他场景必须给终态回执（INV-04）。
        if (replyMessages.length === 0 && !sentAnyAssistantReply) {
          const source = resultSourceCommandId
            ? context.group?.inputs?.[resultSourceCommandId]?.source
            : undefined;
          // 无 @ 续聊允许模型不参与，空输出不能再被“任务已完成”兜底变成抢答。
          if (
            context.group?.threadId &&
            source?.botIdentity &&
            source.mentionedBot === false &&
            !source.messages?.some((message) => message.mentionedBot === true)
          )
            return;
          await sendTaskOutbound(
            bot,
            createOutbound(actor, locale === "en-US" ? "Task completed." : "任务已完成。"),
          );
          return;
        }
// 逐条发送，每条独立投递；deliveryId 递增保证幂等且不互相吞并。
        for (const text of replyMessages) {
          sentAnyAssistantReply = true;
          await sendTaskOutbound(bot, createOutbound(actor, text));
        }
      }
    };
// 事件处理的最后一道闸：无论 impl 如何退出，都要补偿“持久私聊投递失败”。
// [资源] 这里只登记待重试消息并广播状态，真正重试由用户/下一轮触发，不在队列里 sleep。
    const handleStreamEvent = async (
      event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
      shouldBroadcast = true,
    ): Promise<void> => {
      try {
        await handleStreamEventImpl(event, shouldBroadcast);
      } finally {
// 只在终态、本轮确实失败过、且当前仍授权时登记；否则会把过期内容在很久以后重发（INV-05）。
        if (
          persistentPrivate &&
          privateDeliveryFailed &&
          (event.type === "task_complete" || event.type === "task_error") &&
          (await isPrivateAuthorized())
        ) {
          const locale = await readMessageLocale();
// 用本轮 parts 重新组一份完整回复；卡片结果未知时不重发，避免重复。
// 重新组装使用 assistant_changes 而非群模式的 summary_changes：
// 私聊重试只需要完整正文，文件摘要已在原消息里。
          const texts = formatBotAssistantReplyBlocks(
            createAssistantReplyBlocks(assistantParts, toolCalls, "assistant_changes", undefined),
            { workspacePath: context.workspacePath, locale },
          );
          const text =
            texts.join("\n\n") ||
            (event.type === "task_error" ? event.error : msg(locale, "received"));
// 每次登记新 id：UI 用它区分“哪一次重试”，也防止旧重试覆盖新内容。
          const id = randomUUID();
          privateDeliveryFailed = false;
          failedPrivateDeliveries.set(bot.id, {
            id,
            bindingId,
            taskId: context.activeTaskId!,
            message: createOutbound(actor, text),
            sending: false,
          });
// 同步运行时状态，让 Bot 列表出现“可重试投递”入口；读取失败退化为 idle，不阻塞终态。
          const runtime = runtimeByBotId.get(bot.id);
          setRuntimeStatus({
            botId: bot.id,
            provider: bot.provider,
            status: runtime?.status ?? "idle",
            deliveryRetryId: id,
          });
        }
      }
    };
// 事件串行队列：Agent 不保证等待 async listener，并发处理会让 task_complete 的摘要
// 抢在正文 flush 之前（微信尤其明显）。
// [并发] 队列失败被 catch，避免一次异常让后续事件永不再执行。
    let streamEventQueue: Promise<void> = Promise.resolve();
    const enqueueStreamEvent = (
      event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
    ): Promise<void> => {
// 同一事件对象可能同时从 mirror batch 与直接订阅到达，WeakSet 只广播一次。
      const shouldBroadcast = !forwardedTaskEvents.has(event);
      forwardedTaskEvents.add(event);
      const nextStreamEvent = streamEventQueue.then(() =>
        handleStreamEvent(event, shouldBroadcast),
      );
      // Bugfix: ZCode Agent 事件分发不保证等待 async listener。微信这类离散消息如果并发发送，
      // task_complete 的 Change summary 可能抢在前面正文 flush 之前到达客户端，所以这里按任务串行消费。
      streamEventQueue = nextStreamEvent.catch((error: unknown) => {
        botsLogger.warn(
          event.traceId,
          `bot task stream event failed task=${event.taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      return streamEventQueue;
    };
    const dynamicTaskEvent = (
      zcodeTaskService as Partial<Pick<IZCodeTaskService, "onDynamicTaskEvent">>
    ).onDynamicTaskEvent;
    // Bugfix: 远控/共享 host 场景会通过 workspace+task mirror 分发流事件。
    // 这里优先订阅 workspace 级事件，避免只监听本地 taskId relay 时漏掉 channel 回复。
// 优先订阅 workspace 级事件：远控/共享 host 下 UI 收到的是 mirror batch，
// 只监听本地 taskId relay 会漏掉 channel 回复。
    const streamDisposable = taskStreamHub.add(
      JSON.stringify([
        getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
        context.activeTaskId,
      ]),
      streamSubscriptionKey,
      (receive) =>
        dynamicTaskEvent
          ? dynamicTaskEvent({
              workspacePath: context.workspacePath,
              workspaceIdentity: context.workspaceIdentity,
// deliveryKind 固定为 bot-channel-continuous：远控 replayable 的 replay/gap recovery
// 会改变回复边界，Bot 渠道需要 direct stream 语义。
              taskId: context.activeTaskId!,
              // Bugfix: Bot channel 使用 direct stream 语义。
              // 手机远控 replayable 的 mirror replay / snapshot gap recovery 会改变 bot 回复边界，
              // 这里使用 bot 专属 continuous 订阅，避免远控恢复逻辑影响飞书/微信等 channel。
              deliveryKind: "bot-channel-continuous",
            })(receive)
          : zcodeTaskService.onDynamicStreamEvent(context.activeTaskId!)(receive),
      enqueueStreamEvent,
    );
// 登记订阅句柄：imInput 标记本轮由 IM 发起，automation 预约自动化 run；
// dispose 是唯一释放入口，同时置 disposed 与释放 hub 订阅（INV-12）。
    streamSubscriptions.set(streamSubscriptionKey, {
      imInput() {
        if (!resultRunId) imInteractionRun = true;
      },
      automation(runId) {
        if (runId) automationRuns.add(runId);
        else {
          automationPending = true;
          if (!resultRunId) automationRun = true;
        }
      },
      dispose() {
        disposed = true;
        streamDisposable.dispose();
      },
    });
// 临时私聊补 typing；群场景由具体命令处理，避免多人并发时互相覆盖。
    if (!context.group && !persistentPrivate) startTyping(bot, actor, context.activeTaskId);
  }

// 把 SelectionPrompt 变成一条出站消息：结构化渠道带 options，纯文本渠道退化为编号列表。
// [并发] 同时写入 pendingSelectionsByContext，供后续短序号回调反查真实 option（INV-11）。
// 返回数组是为了与其他回复构造器保持统一签名（适配器可能按长度拆分）。
  async function createSelectionReply(
    actor: BotActor,
    selection: SelectionPrompt,
    locale?: Locale,
    extras: Pick<BotOutboundMessage, "elicitation" | "locale"> = {},
  ): Promise<BotOutboundMessage[]> {
// markCurrentSelection 只加展示标记，不改 option.id——id 是回调契约。
    const markedSelection = markCurrentSelection(selection, locale);
    // Bugfix: 微信没有原生选项卡能力，只能走纯文本编号选项。
    // 之前纯文本 fallback 会同时展示标题里的“当前”和选项上的“当前”标记，
    // 微信回复看起来像重复状态文案；这里让标题负责说明当前状态，列表只保留可回复的编号。
// 微信没有原生选项卡，只能走文本编号；其余渠道保留结构化 options。
// 纯文本编号依赖 selection.options 顺序，因此不能在这里重排选项。
    const supportsStructuredSelection = actor.provider !== "weixin";
    // Bugfix: 微信 /model 第一层选择的是供应商，之前复用 description 把模型列表也拼进同一行，
    // 导致用户还没选供应商就看到两层信息。纯文本通道先只展示供应商，模型放到下一层再展示。
// 纯文本下供应商描述里混着模型列表，会让用户在第一层就看到下一层信息。
    const textSelection = stripModelProviderDescriptionsForTextSelection(selection);
    const displaySelection = supportsStructuredSelection
      ? markedSelection
      : { ...textSelection, cancelLabel: markedSelection.cancelLabel };
// 结构化渠道也登记 selection：卡片回调可能只带短序号，仍需内存映射还原。
    pendingSelectionsByContext.set(getActorContextKey(actor), displaySelection);
    // 其他 provider 保留 selection，让 Telegram/飞书/Lark 渲染原生选项，也让 Webhook 接收结构化选项。
// 文本只发标题，选项由 formatSelectionFallback 编号渲染；结构化渠道把整个 selection 交给适配器。
// fallback 文本与结构化 options 同时生成，保证两条通道内容一致。
    const text = supportsStructuredSelection
      ? displaySelection.title
      : formatSelectionFallback(displaySelection, locale);
    return [
      createOutbound(actor, text, supportsStructuredSelection ? displaySelection : undefined, {
        ...extras,
        locale,
      }),
    ];
  }

// 取消入口：必须区分“取消菜单”与“取消问答”。
// [失败路径] 没有任何 pending 时回 unknownCommand，而不是假装取消成功。
// 取消只结束选择态，不改变任务状态，因此不写 context。
  async function handleSelectionCancel(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const locale = await readMessageLocale();
    const actorContextKey = getActorContextKey(message.actor);
    const pendingSelection = pendingSelectionsByContext.get(actorContextKey);
// 群内取消一律走鉴权：取消是写操作，不能靠消息文本判断身份（INV-01）。
    if (message.actor.chatType === "group") {
      const auth = await withAuthorizedContext(message, "message");
      if (!auth.ok) return auth.reply;
      clearPendingSelection(message.actor);
      return createStatusReply(message.actor, auth.context, locale);
    }
// 取消的是 elicitation 时，必须把 cancel 回传 Agent，
// 否则任务会一直等一个用户已经放弃的问题（INV-04）。
    if (pendingSelection?.action === "elicitation.respond") {
      const auth = await withAuthorizedContext(message, "message");
      if (!auth.ok) return auth.reply;
      const pending = auth.context.pendingElicitation;
// selection 存在但 pending 已消失：先清选择缓存，再回“已过期”。
      if (!pending) {
        clearPendingSelection(message.actor);
        return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
      }
      clearPendingSelection(message.actor);
      return submitPendingElicitation(auth, message.actor, pending, "cancel");
    }
// 没有 selection 但有 pending：允许用取消命令结束问答（例如卡片已被删除）。
    if (!pendingSelectionsByContext.has(actorContextKey)) {
      const auth = await withAuthorizedContext(message, "message");
      if (auth.ok && auth.context.pendingElicitation) {
        return submitPendingElicitation(
          auth,
          message.actor,
          auth.context.pendingElicitation,
          "cancel",
        );
      }
      return [createOutbound(message.actor, msg(locale, "unknownCommand", { command: "0" }))];
    }
// 普通菜单取消：清缓存后回状态摘要，让用户知道已退出选择态。
    clearPendingSelection(message.actor);
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    return createStatusReply(message.actor, auth.context, auth.locale);
  }

  // 命令级去重键：回答“同一个对话对象是否已经在为同一 workspace 重连”。
  // [权衡] 不把 threadId 放进键：话题与群默认任务共享同一条远端连接，
  // 分开计键会让同一 workspace 被并发 ensureConnected 两次。
  function buildRemoteReconnectCommandKey(
    actor: BotActor,
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): string {
    return [
      actor.botId,
      actor.provider,
      // chatId 优先：群成员共用群会话，不能按人拆开；私聊没有 chatId，退回发送者。
      actor.chatId ?? actor.providerUserId,
      // workspaceIdentity 优先于 path：同路径不同 Host 是两套 runtime（INV-05）。
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
    ].join("::");
  }

  // 投递级去重键：同一条 provider 消息被重复投递时必须落回同一个键（INV-03 的通用形态）。
  // 返回 null 表示消息缺 provider message id，无法做消息级幂等；调用方只能退回
  // 命令级短 TTL。这里不能伪造一个 id 顶替，否则会把不相关的消息误合并成一次重连。
  function buildRemoteReconnectDeliveryKey(message: BotInboundMessage): string | null {
    const providerMessageId = message.actor.providerMessageId?.trim();
    if (!providerMessageId) {
      return null;
    }
    return [
      message.actor.botId,
      message.actor.provider,
      // Telegram 等 provider 的 message id 只在单个会话内唯一，必须带会话维度。
      message.actor.chatId ?? message.actor.providerUserId,
      providerMessageId,
    ].join("::");
  }

  // [资源] 投递级去重表是进程内 Map，只能靠时间窗口淘汰。不清理的话，长驻进程
  // 会按“历史消息数”线性增长，最终变成内存泄漏；这里在每次 /reconnect 前扫一遍全表，
  // 重连是低频命令，O(n) 的代价可以忽略。
  // 窗口取 2 分钟而不是命令级的 3 秒：provider 重投可能晚到几十秒，
  // 3 秒窗口只能压制并发风暴，挡不住“几分钟后补投”的重复消息。
  function pruneRecentRemoteReconnectDeliveryDedupe(now: number): void {
    for (const [key, at] of recentRemoteReconnectDeliveryAtByKey) {
      if (now - at >= REMOTE_RECONNECT_DELIVERY_DEDUPE_TTL_MS) {
        recentRemoteReconnectDeliveryAtByKey.delete(key);
      }
    }
  }

  // 真正执行远端连接。职责边界：只做连接与后置状态收敛，不重复鉴权、不重复去重
  // （两者已由 handleReconnect 完成，重做会在重连成功后留下第二份授权快照）。
  // ensureConnected 抛错时转成 { ok:false } 而不是继续抛出：重连失败必须变成
  // 一条用户可见的回复；抛出会被外层当成业务失败，触发 inbound delivery 归还与重投。
  async function performRemoteReconnect(
    message: BotInboundMessage,
    auth: Extract<Awaited<ReturnType<typeof withAuthorizedContext>>, { ok: true }>,
  ): Promise<BotOutboundMessage[]> {
    let result: BotRemoteWorkspaceReconnectResult;
    try {
      result = await reconnectRemoteWorkspaceForBot(auth.context);
    } catch (error) {
      // [失败路径] 把异常文本降级成结果对象：这条链路已经产生过可观察副作用
      // （用户已收到“正在重连”），不能再让上层把它当作未处理消息重放一次。
      result = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!result.ok) {
      // 失败时提醒管理员（remote 关注点）：远端断连通常需要人来处理，静默失败
      // 会让用户以为只是“没反应”，反复重试反而制造重连风暴。
      return [
        administratorReply(
          message.actor,
          auth.bot,
          "remote",
          createOutbound(
            message.actor,
            msg(auth.locale, "remoteReconnectFailed", {
              workspacePath: auth.context.workspacePath,
              message: result.message ?? "unknown",
            }),
          ),
        ),
      ];
    }
    // 连接恢复后立刻清掉提醒，否则管理员会被一直 @，直到下一条无关命令才消停。
    adminAttention.clear(message.actor, auth.bot.providerUserId, "remote");
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      // 断连期间 ensureDraftOptions 只能给出最小默认值（见 buildInitializedDraftOptions），
      // 这里必须按已连上的远端 catalog 重新初始化，否则用户看到的模型/模式仍是降级值。
      const draftOptions = await buildInitializedDraftOptions(auth.context);
      // [并发] 仍走 writeContext 的合并写：它按 key 读最新状态再合并，只替换
      // draftOptions，不会把并发的群启用/换绑结果用旧快照顶回去。
      await writeContext({ ...auth.context, draftOptions });
    }
    // 私聊订阅的建立条件是“已连接”，重连成功后需要重新对账一次；
    // 该函数内部已把失败降级为日志 + 投递错误记录，不会推翻“已重连成功”的结论。
    await reconcilePrivateSynchronization(auth.context.botId);
    // 成功重连后统一回完整状态，避免命令完成文案和 /status 内容分裂。
    return createStatusReply(message.actor, auth.context, auth.locale);
  }

  // /reconnect 的唯一入口。检查顺序是刻意排的（INV-01 → INV-05 → 去重 → 副作用）：
  // 鉴权必须先于去重，否则被停用的 bot 发来的重复消息会被“静默吞掉”，
  // 用户得不到任何反馈；反过来先去重再鉴权，还会让未授权者占用去重槽位。
  async function handleReconnect(
    message: BotInboundMessage,
    options: {
      onReconnectStart?: (
        auth: Extract<Awaited<ReturnType<typeof withAuthorizedContext>>, { ok: true }>,
      ) => Promise<void>;
    } = {},
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "workspace");
    if (!auth.ok) return auth.reply;
    // 本地 workspace 不需要远端连接；这里直接回一句“本地项目无需重连”，
    // 而不是继续走到 ensureConnected —— 后者会为本地路径凭空创建远端会话。
    if (!auth.context.workspaceIdentity) {
      return [createOutbound(message.actor, msg(auth.locale, "remoteReconnectLocal"))];
    }
    if (!deps.remoteWorkspaceService) {
      // 没注入重连服务时明确告知不可用。若当作成功返回，用户会以为已连上，
      // 下一条任务才会在远端 API 层报出“模型不存在”这类误导性错误（INV-05）。
      return [
        createOutbound(
          message.actor,
          msg(auth.locale, "remoteReconnectUnavailable", {
            workspacePath: auth.context.workspacePath,
          }),
        ),
      ];
    }

    const now = Date.now();
    pruneRecentRemoteReconnectDeliveryDedupe(now);
    const deliveryKey = buildRemoteReconnectDeliveryKey(message);
    if (deliveryKey && recentRemoteReconnectDeliveryAtByKey.has(deliveryKey)) {
      // 同一条 provider 消息的重复投递：返回空数组表示“没有新回复”，上游因此
      // 不再发送正文；同时不调用 releaseInboundDelivery —— 这条投递已经被确认过，
      // 释放它只会让同一条消息再次进入处理流程。
      return [];
    }
    if (deliveryKey) {
      // Bugfix: 飞书/微信/Telegram 都可能重投同一条 provider message。
      // /reconnect 有副作用，必须在真正执行前就按 provider message id 幂等，
      // 否则重投会再次命中“已连接”分支，用户会看到重复的成功提示。
      // 占位与执行之间没有 await，因此不存在“检查通过但尚未登记”的并发窗口。
      recentRemoteReconnectDeliveryAtByKey.set(deliveryKey, now);
    }

    const reconnectKey = buildRemoteReconnectCommandKey(message.actor, auth.context);
    const pendingReconnect = pendingRemoteReconnectsByKey.get(reconnectKey);
    if (pendingReconnect) {
      // [并发] 同键重连已在飞行中：等它结束再返回空，既不让第二个调用者重复
      // 打开连接，也保证“第一条命令的回复先于第二条返回”。用 catch 吞掉失败，
      // 因为失败本身已经由第一个调用者回复给用户，这里再抛会重复打扰。
      await pendingReconnect.catch(() => []);
      return [];
    }
    const recentReconnectAt = recentRemoteReconnectAtByKey.get(reconnectKey);
    if (
      recentReconnectAt !== undefined &&
      now - recentReconnectAt < REMOTE_RECONNECT_DEDUPE_TTL_MS
    ) {
      // 3 秒的“刚成功过”窗口：用户连点或 provider 换新 messageId 重投时，
      // 不再走一次 ensureConnected。窗口刻意很短，避免用户真想重连时被长时间挡住。
      return [];
    }
    if (await isRemoteWorkspaceConnected(auth.context)) {
      // 已连上就只回状态：/reconnect 应当幂等，不能因为“再连一次”而重置会话。
      return createStatusReply(message.actor, auth.context, auth.locale);
    }

    // Bugfix: Feishu/Lark/Webhook 这类 provider 可能把同一条 /reconnect 在短时间内重复投递。
    // /reconnect 本身有副作用，必须按 bot+用户+workspace 做幂等，否则会同时出现“已连接”和“正在重连”等互相打架的状态。
    // [并发] 这个 async IIFE 会同步执行到第一个 await（onReconnectStart），随后立刻把
    // Promise 登记进 map——中间没有让出事件循环的机会，所以不存在第二个调用者
    // 看到“既无 pending 也未被登记”的窗口。
    const reconnectPromise = (async () => {
      if (options.onReconnectStart) {
        try {
          await options.onReconnectStart(auth);
        } catch (error) {
          // Bugfix: “正在重连”只是即时状态提示，发送失败不能中断真正的远端重连。
          // 若在这里 rethrow，用户会看到错误但连接其实没被尝试，与命令语义不符。
          botsLogger.warn(
            undefined,
            `send reconnect starting failed provider=${message.actor.provider} bot=${message.botId} user=${message.actor.providerUserId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return performRemoteReconnect(message, auth);
    })();
    pendingRemoteReconnectsByKey.set(reconnectKey, reconnectPromise);
    try {
      const replies = await reconnectPromise;
      // 只有成功才记录时间戳：失败后保留可重试性，用户不必等 3 秒窗口过期。
      recentRemoteReconnectAtByKey.set(reconnectKey, Date.now());
      return replies;
    } finally {
      // [资源] 无论成功/失败都必须撤销 in-flight 登记，否则该键会被一个已结束的
      // Promise 永久占位，后续所有 /reconnect 都走“等待旧的”分支而永不执行。
      pendingRemoteReconnectsByKey.delete(reconnectKey);
    }
  }

  // 所有命令的鉴权闸门。分层顺序即安全边界，任何一层提前返回都不会产生副作用：
  // STEP-1 bot 身份（enabled + providerUserId/botId 匹配）
  // STEP-2 会话形态（非私聊仅 Feishu 系支持）
  // STEP-3 群授权（enabled + ownerId 一致 + 卡片归属）
  // STEP-4 角色（owner 专属命令 / 群内回答资格）
  // STEP-5 命令策略（allowedCommands）
  // STEP-6 workspace 授权（workspaceId ∈ allowedWorkspaces）
  // STEP-7 远端可用性（INV-05，只拦需要 runtime 的命令）
  // 反过来（先查命令策略、后查身份）会让未绑定者探测到 bot 配置了哪些命令。
  async function withAuthorizedContext(
    message: BotInboundMessage,
    requestedCommand: BotAuthorizedCommand,
  ): Promise<
    | {
        ok: true;
        config: BotsConfigFile;
        bot: BotConfig;
        // 私聊时是“绑定的用户配置”，群聊时是用群选择合成的伪用户，二者字段口径不同。
        user: BotConfig;
        context: BotContextState;
        locale: Locale | undefined;
      }
    | { ok: false; reply: BotOutboundMessage[] }
  > {
    const locale = await readMessageLocale();
    const config = await repo.readConfig();
    // findAuthorizedBot 的匹配维度随会话形态不同：群里按 botId+provider，私聊按
    // providerUserId（weixin 例外，按 botId）——私聊的绑定关系就写在 bot 记录上。
    const bot = findAuthorizedBot(config, message.actor);
    if (!bot || bot.id !== message.botId) {
      // INV-01：身份不符统一回“bot 已停用”，不区分“不存在/未绑定/已停用”，
      // 避免外部用错误信息枚举 bot 配置。botId 二次比对是必要的：私聊匹配只用了
      // providerUserId，换绑后旧 botId 的消息不能被新 bot 继承。
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "botDisabled"))],
      };
    }
    if (message.actor.chatType !== "private" && !isFeishuBotProvider(bot.provider)) {
      // 微信/Telegram 只有 1:1 会话，群语义（owner、群授权、话题）无处存放；
      // 若放行，群 chatId 会被当成私聊键写入 state，等于给整群开了一个人的权限。
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "privateChatOnly"))],
      };
    }
    const groupContext =
      message.actor.chatType === "group" ? await readContext(message.actor, bot) : null;
    if (message.actor.chatType === "group") {
      if (!groupContext?.group?.enabled || groupContext.group.ownerId !== bot.providerUserId) {
        // 群授权是单一权威（INV-01）：ownerId 必须等于 bot 当前绑定的 providerUserId，
        // 换绑后旧群即使 enabled 仍为 true 也不能继续执行。
        return {
          ok: false,
          reply: [
            {
              ...administratorReply(
                message.actor,
                bot,
                "group-disabled",
                createOutbound(message.actor, msg(locale, "groupNotEnabled")),
              ),
              // 这条多半来自旧卡片按钮：用 toast 回执，避免在群里追加一条无效消息。
              callbackToastOnly: true,
            },
          ],
        };
      }
      if (message.groupCard || message.groupCardAction) {
        const card = message.groupCard;
        if (
          !card ||
          card.chatId !== groupContext.group.chatId ||
          card.threadId !== message.actor.threadId ||
          getBotConversationKey({ botId: bot.id, chatType: "group", ...card }) !==
            getBotStateKey(groupContext) ||
          card.taskId !== groupContext.activeTaskId ||
          card.authorizationId !== groupContext.group.authorizationId
        ) {
          // [失败路径] 卡片字段来自回调 payload，属于外部可控输入：这里只做“收紧”，
          // 五元组必须与持久态完全一致。少任一维度，旧授权的卡片就能操作新任务，
          // 例如群被 /disable 后重新 /enable，旧卡片会凭旧 authorizationId 通过鉴权。
          return {
            ok: false,
            reply: [
              {
                ...createOutbound(message.actor, msg(locale, "elicitationExpired")),
                callbackToastOnly: true,
              },
            ],
          };
        }
      }
      adminAttention.clear(message.actor, bot.providerUserId, "group-disabled");
      if (
        requestedCommand === "reply" ||
        (isGroupOwnerCommand(requestedCommand) &&
          message.actor.providerUserId !== bot.providerUserId)
      ) {
        // 群内两种拒绝共用一个返回结构：
        // - /reply 是私聊专属命令（群内回复走话题/摘要投递），任何人都不接受；
        // - 其余 owner 命令（new/stop/approve/deny/workspace/model/...）只认 owner。
        // 注意 ownerId 与 bot.providerUserId 在此处等价（上面已校验一致）。
        return {
          ok: false,
          reply: [
            {
              ...(requestedCommand === "reply"
                ? createOutbound(message.actor, msg(locale, "groupOwnerOnly"))
                : administratorReply(
                    message.actor,
                    bot,
                    // 权限审批被非 owner 触发时，提醒原因要带上具体 requestId，
                    // 否则管理员无法从多条审批中定位是哪一张卡需要他操作。
                    requestedCommand === "approve" && groupContext.pendingPermissionOptions?.[0]
                      ? `permission:${groupContext.activeTaskId}:${groupContext.pendingPermissionOptions[0].requestId}`
                      : "owner-command",
                    createOutbound(message.actor, msg(locale, "groupOwnerOnly")),
                  )),
              callbackToastOnly: true,
            },
          ],
        };
      }
    }
    if (
      groupContext &&
      message.actor.providerUserId === bot.providerUserId &&
      isGroupOwnerCommand(requestedCommand)
    ) {
      // 真正的 owner 已经亲自执行，之前因为“需要管理员”积累的提醒可以撤销。
      adminAttention.clear(message.actor, bot.providerUserId, "owner-command");
    }
    const user = groupContext
      ? {
          // 群成员没有各自的 bot 配置：执行策略沿用 bot，但选择项必须取群当前值，
          // 否则群里 /model 展示的是 bot 默认值而不是本群实际在用的模型。
          ...bot,
          currentOptions: groupContext.group!.currentOptions,
          // 群聊强制摘要式回复：逐条变更会产生大量消息，且群成员只关心结果。
          replyMode: "summary_changes" as const,
        }
      : findBoundUser(bot, message.actor);
    if (!user) {
      // 私聊未绑定：这里同样不透露 bot 是否存在，只给“未绑定”这一可操作提示。
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "userNotBound"))],
      };
    }
    if (!isUserCommandAllowed(user, requestedCommand)) {
      // INV-01：命令白名单来自 bot 配置（allowedCommands），与消息正文/@ 文本无关；
      // 群成员的 user 是上面合成的伪用户，同样引用 bot 的策略，不存在“群里能绕过”。
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "commandNotAllowed"))],
      };
    }
    if (groupContext?.group) {
      const parsed = parseBotCommand(message.commandText ?? message.text);
      const isAnswer =
        message.senderType !== "app" &&
        (Boolean(message.elicitationResponse) ||
          parsed.type === "elicitation.respond" ||
          parsed.type === "elicitation.submit");
      if (
        isAnswer &&
        !canAnswerGroupQuestion(
          message.actor.providerUserId,
          groupContext.group.ownerId,
          groupContext.group.initiatorId,
          groupContext.pendingElicitation?.renderContext?.kind === "plan_approval",
        )
      ) {
        // [失败路径] 回答会直接改变任务（选择模型、批准计划、授权工具）。
        // 规则：owner 永远可答；普通问题发起人可答；plan_approval 只允许 owner——
        // 否则旁观的群成员可以替发起人批准执行计划。
        // senderType === "app" 的消息是机器人自己/其他应用的回显，不能算作回答，
        // 否则回显文本会被当成用户意图再提交一次。
        return {
          ok: false,
          reply: [
            {
              ...(groupContext.pendingElicitation?.renderContext?.kind === "plan_approval"
                ? administratorReply(
                    message.actor,
                    bot,
                    // plan 审批的提醒必须精确到 requestId，管理员才能对上卡片。
                    `plan:${groupContext.activeTaskId}:${groupContext.pendingElicitation.requestId}`,
                    createOutbound(message.actor, msg(locale, "groupOwnerOnly")),
                  )
                : createOutbound(message.actor, msg(locale, "groupOwnerOnly"))),
              callbackToastOnly: true,
            },
          ],
        };
      }
    }
    // 群里复用上面读到的上下文，避免第二次 readState 期间授权被并发改写后
    // 出现“按旧上下文放行、按新上下文执行”的错配；私聊此时才首次读上下文。
    const context = groupContext ?? (await readContext(message.actor, bot));
    if (!context) {
      // 私聊没有可用上下文（未绑定项目/旧记录不可迁移）：这个提示必须带管理员提醒，
      // 因为普通用户无法自行完成 workspace 绑定。
      return {
        ok: false,
        reply: [
          administratorReply(
            message.actor,
            bot,
            "workspace",
            createOutbound(message.actor, msg(locale, "noWorkspaceAllowed")),
          ),
        ],
      };
    }
    const synced = context.group
      ? { config, bot, user }
      : await normalizeBotWorkspaceConfig(config, bot, {
          // 旧上下文可能只有 workspacePath；用 identity 优先的 key 兜底，
          // 但绝不把 path 当成 identity 写进授权（INV-05 的同路径不同 Host 问题）。
          id:
            context.workspaceId ??
            getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
          label: getWorkspaceLabel(context.workspacePath),
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
        });
    // [事务] 群聊跳过 normalize：该函数可能 writeBotConfig，而群消息是高频路径，
    // 每个成员每句话都写一次配置既浪费又会与并发修改打架；群的 workspace
    // 来自父会话，本身不需要在这里被“授权登记”。
    if (
      context.workspaceId &&
      !isWorkspaceAllowed(context.workspaceId, synced.user.allowedWorkspaces)
    ) {
      // INV-01：workspace 授权以持久化的 workspaceId 为准，不重新按路径推断。
      // [权衡] workspaceId 为空（旧记录）时不拦截，交由上面的 normalize 迁移；
      // 这是历史数据兼容的代价，新写入的上下文都会带 workspaceId。
      return {
        ok: false,
        reply: [
          administratorReply(
            message.actor,
            bot,
            "workspace",
            createOutbound(message.actor, msg(locale, "workspaceOutOfScope")),
          ),
        ],
      };
    }
    const remoteDisconnectedReply = await blockDisconnectedRemoteWorkspace({
      message,
      context,
      locale,
      requestedCommand,
    });
    if (remoteDisconnectedReply) {
      // INV-05：远端未连接时不放行任何需要 runtime 的命令。放在最后一步，
      // 是为了不让未授权调用者借这条分支探测远端连接状态。
      return { ok: false, reply: remoteDisconnectedReply };
    }
    if (isFeishuBotProvider(bot.provider) && !context.group) {
      // Bugfix: 飞书短命令 typing 现在由同步回复完成后显式删除。
      // 这里必须等 reaction 创建完成，否则 stopInboundTyping 可能先执行，最终留下无法清理的 Typing reaction。
      await sendTyping(bot, message.actor);
    } else if (!context.group) {
      // [权衡] 其他 provider 没有可回滚的 reaction 句柄，只能 fire-and-forget：
      // 等待它完成会让命令首字延迟，而失败也只是少一个“正在输入”提示。
      // 群聊不发 typing：群场景的进度由表情/队列卡表达，typing 会被所有人看到。
      void sendTyping(bot, message.actor);
    }
    return {
      ok: true,
      config: synced.config,
      bot: synced.bot,
      // 群里必须回伪用户（带群 currentOptions），不能用 synced.user 覆盖，
      // 否则后续命令读到的是 bot 默认模型而不是本群选择。
      user: groupContext ? user : synced.user,
      context,
      locale,
    };
  }

  // /bind 的兑换入口。绑定码是“管理员为 bot 签发的一次性凭据”，因此这里做了三层约束：
  // 只能私聊兑换（绑定的是 1:1 会话）、必须未过期、必须属于当前 bot。
  // 绑定成功后直接改写 bot.providerUserId —— 一个 bot 同时只能有一个沟通对象。
  async function handleBind(
    message: BotInboundMessage,
    code: string,
  ): Promise<BotOutboundMessage[]> {
    const locale = await readMessageLocale();
    if (message.actor.chatType !== "private") {
      // 群成员数量不可控；若允许群内兑换，任何一个群成员都能把整个 bot 抢绑到自己名下。
      return [createOutbound(message.actor, msg(locale, "bindPrivateOnly"))];
    }
    // bindCodes 的 key 一律 toUpperCase 后再查：用户从管理员那里复制时经常被输入法改大小写。
    // [资源] bindCodes 只存在进程内存里，进程重启即全部失效；这是有意的——
    // 绑定码是短期凭据，不落盘就不会在磁盘上留下可被离线重放的授权材料。
    const record = bindCodes.get(code.trim().toUpperCase());
    if (!record || record.expiresAt <= Date.now() || record.botId !== message.botId) {
      // 三种失败合并成同一个提示：不区分“不存在/过期/不是这个 bot 的码”，
      // 否则攻击者可以拿任意码来试探哪些 bot 正在等待绑定。
      return [createOutbound(message.actor, msg(locale, "bindCodeInvalid"))];
    }
    const config = await repo.readConfig();
    const bot = findBot(config, record.botId);
    if (!bot) {
      // 码仍在内存但 bot 已被删除：报“bot 不存在”，不要静默吞掉，
      // 否则管理员会以为是码失效而反复重发。
      return [createOutbound(message.actor, msg(locale, "bindBotMissing"))];
    }
    // Bot 配置化后 /bind 只绑定当前 bot，不再向 bot 追加 allowedUsers。
    // 重新绑定会覆盖旧 providerUserId，保证一个 bot 同一时间只有一个沟通对象。
    // 注意 allowedCommands/replyMode 是“重新归一化”而不是沿用 record 的快照：
    // 绑定码只携带 workspace 范围，其余策略始终以配置中心当前值为准。
    const nextBot: BotConfig = {
      ...bot,
      providerUserId: message.actor.providerUserId,
      displayName: message.actor.displayName,
      allowedWorkspaces: normalizeAllowedWorkspaces(record.allowedWorkspaces),
      allowedCommands: normalizeBotCommandPolicy(bot.allowedCommands),
      replyMode: normalizeBotReplyGranularity(bot.provider, bot.replyMode),
    };
    // 先校验再落盘：非法配置必须在写入前被挡住，否则会把 bot 写进崩溃态。
    validateBotConfig(config, nextBot);
    // [事务] writeBotConfig 不只是替换一条记录：它会按 providerUserId/credentialRef
    // 的变化失效旧私聊绑定与所有群/话题，并在同一次串行写里标记卡片失效（INV-10）。
    // 所以“换绑”天然是一种原子撤销，不需要在这里手工清理群状态。
    await writeBotConfig({
      ...config,
      bots: config.bots.map((item) => (item.id === nextBot.id ? nextBot : item)),
    });
    // [失败路径] 删除放在写盘之后：写盘失败时码仍然可用，用户可以重试；
    // 反之先删后写，一旦落盘失败，管理员必须重新签发一个码。代价是失败期间
    // 同一码可被反复尝试，直到自然过期（TTL 由 BOT_BIND_CODE_TTL_MS 控制）。
    bindCodes.delete(record.code);
    return [
      createOutbound(
        message.actor,
        // 绑定成功后顺带给出帮助，用户不用再发一次 /help 才知道能做什么。
        [msg(locale, "bindSuccess"), buildHelpText(locale, nextBot)].join("\n\n"),
      ),
    ];
  }

  // /status 走与普通命令完全相同的鉴权链：状态里含 workspace 路径与任务 id，
  // 不能让未授权者通过“只读命令”绕过授权。
  async function handleStatus(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "status");
    if (!auth.ok) {
      return auth.reply;
    }
    // 群内 /status 与配置后的状态回复共用脱敏入口，避免单独分支泄露绝对路径。
    return createStatusReply(message.actor, auth.context, auth.locale);
  }

  // 状态文案的唯一出口。/status、/reconnect 成功、以及部分命令的回执都复用这里，
  // 目的是让“命令结果文案”和“状态面板”永远同源，不会出现两套状态口径。
  async function createStatusReply(
    actor: BotActor,
    context: BotContextState,
    locale: Locale | undefined,
  ): Promise<BotOutboundMessage[]> {
    return [
      createOutbound(
        actor,
        context.group
          ? (await buildStatusText(context, locale))
              // [权衡] 用 split/join 做全局替换而不是 RegExp：workspacePath 里可能含
              // 正则元字符（Windows 的 \、用户目录里的 . 与 ( ），转义遗漏会直接抛
              // “Invalid regular expression”，把一条只读命令变成错误。
              .split(context.workspacePath)
              .join(getWorkspaceLabel(context.workspacePath))
          : await buildStatusText(context, locale),
        undefined,
        {
          locale,
        },
      ),
    ];
  }

  function formatStatusLine(
    locale: Locale | undefined,
    labelId: BotMessageId,
    value: string,
  ): string {
    // Bugfix: /status 文案由服务层拼接，标签和值都要跟随 bot 当前 locale。
    // 值本身由调用方决定口径（路径已脱敏、状态已本地化、模型已解码为 provider 名）。
    return `${msg(locale, labelId)}: ${value}`;
  }

  // 任务状态字符串 → 用户可读文案。状态源头是 CLI 协议里的英文枚举，
  // 这里做“展示层映射”，不能反过来用它做状态判断（否则本地化会污染业务分支）。
  function formatStatusStateValue(locale: Locale | undefined, state: string): string {
    if (locale === "en-US") {
      // 英文环境下协议枚举本身就是可读的英文，直接透传，避免维护第二份同义文案。
      return state;
    }
    switch (state) {
      case "draft":
        return msg(locale, "statusDraft");
      case "remote disconnected":
        return msg(locale, "statusRemoteDisconnected");
      case "running":
        return msg(locale, "streamingStatusRunning");
      case "completed":
        return msg(locale, "streamingStatusCompleted");
      case "error":
      case "failed":
        // error 与 failed 是两条来源不同的状态（协议错误 vs 任务失败），
        // 对用户是同一件事：都展示为“失败”。
        return msg(locale, "streamingStatusFailed");
      case "cancelled":
        return msg(locale, "statusCancelled");
      case "stopped":
        return msg(locale, "statusStopped");
      default:
        // [失败路径] 未知状态原样透出而不是显示成“未知”：
        // 新协议状态未及时补文案时，至少保留了可排查的原文。
        return state;
    }
  }

  // /status 的正文构建。两条路径严格分开：
  // A) 远端未连接 → 只用本地/catalog 数据拼最小面板（INV-05，禁止触碰 runtime）；
  // B) 已连接 → 读 task 列表 + snapshot 拼完整面板。
  async function buildStatusText(
    context: BotContextState,
    locale: Locale | undefined,
  ): Promise<string> {
    // 只读项目目录拿展示名；取不到就回退到路径，保证面板一定有 workspace 行。
    const workspace = (await listWorkspaceRefs()).find((item) => item.id === context.workspaceId);
    if (!(await isRemoteWorkspaceConnected(context))) {
      const draftOptions = context.draftOptions;
      // 断连分支只能展示草稿缓存（可能是重连前的最小默认值），不能调用
      // resolveZCodeTaskServiceForContext —— 那会隐式申请远端 runtime（INV-05）。
      return [
        formatStatusLine(locale, "statusWorkspace", workspace?.label ?? context.workspacePath),
        formatStatusLine(
          locale,
          "statusModel",
          await formatStatusModelLabel(
            formatBotModelSelectionValue(draftOptions?.modelSelection),
            context,
          ),
        ),
        "------",
        // 这里显示 activeTaskId 而不是任务标题：断连时读不到任务元信息，
        // 但 id 仍可帮助用户/支持人员确认当前上下文。
        formatStatusLine(locale, "statusTask", context.activeTaskId ?? msg(locale, "statusDraft")),
        formatStatusLine(
          locale,
          "statusState",
          formatStatusStateValue(locale, "remote disconnected"),
        ),
        msg(locale, "remoteDisconnectedStatus", {
          workspacePath: context.workspacePath,
        }),
      ].join("\n");
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    const tasks = await zcodeTaskService.listTasks({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    const activeTask = context.activeTaskId
      ? tasks.find((task) => task.taskId === context.activeTaskId)
      : null;
    const activeTaskSnapshot = context.activeTaskId
      ? await zcodeTaskService
          .getTaskSnapshot({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          // [失败路径] 快照是可选增强：任务刚被清理/索引尚未就绪时会读不到。
          // 这里吞成 null，让面板继续用 listTasks 的 meta 输出，而不是整条命令失败。
          .catch(() => null)
      : null;
    // Bugfix: activeTaskId 来自 bot context，不应依赖 listTasks 必然返回同一条任务。
    // 某些筛选/索引时序下 listTasks 找不到 active task，之前会跳过 snapshot，导致 Progress 永远缺失。
    // 反过来说：snapshot.meta 是 CLI 的权威投影，优先级与 listTasks 同级即可，
    // 二者都缺失时才退化成“草稿面板”。
    const statusTask = activeTask ?? activeTaskSnapshot?.meta ?? null;
    // Bugfix: 任务结束后 /status 只保留最终状态，避免把最后一次工具/思考进度误看成仍在执行。
    // 条件里保留 `!statusTask`：任务元信息缺失时无法判断是否已结束，
    // 此时仍展示进度，比显示空白更有诊断价值。
    // 优先读内存映射：流式阶段它比 snapshot 更新，能反映“正在做什么”。
    const latestProgress =
      context.activeTaskId && (!statusTask || taskStatus(statusTask) === "running")
        ? (liveStatusProgressByTaskId.get(context.activeTaskId)?.text ??
          readLatestTaskProgress(activeTaskSnapshot))
        : null;
    // 累计工作时长来自 snapshot + meta 两处；只有拿到 statusTask 才有意义。
    const workedDurationMs = statusTask
      ? readTaskWorkedDurationMs(activeTaskSnapshot, statusTask)
      : null;
    const activeTaskConfigOptions = context.activeTaskId
      ? await listActiveTaskConfigOptions(context, context.activeTaskId)
      : [];
    const isDraftStatus = context.mode === "draft" || !context.activeTaskId;
    // [权衡] ensureDraftOptions 在缺少 draftOptions 时会 writeContext ——
    // /status 这个只读命令因此可能落盘。代价换来的是：面板上展示的模型
    // 就是下一步真正会派发的模型，不会出现“看的是一个、跑的是另一个”。
    const draftOptions = !statusTask && isDraftStatus ? await ensureDraftOptions(context) : null;
    // Bot Draft 属于 Select：未显式固定模型时只展示目标 Host 当前首选，不把默认值写回配置。
    // INV-08：这里只读取视图，effectiveSelection 仅当用户显式选过才使用，
    // preferredSelection 是“如果现在派发会用哪个”，二者不可互相覆盖。
    const draftView = draftOptions
      ? await readModelSelectionView(context, draftOptions.modelSelection)
      : null;
    const draftEffectiveSelection = draftOptions?.modelSelection
      ? draftView?.effectiveSelection
      : draftView?.preferredSelection;
    // 优先级：任务配置的当前值 > 任务 meta 上的 model > 草稿有效选择 > "-"。
    // 任务态必须以运行时值为准，否则用户刚 /model 切过、面板还显示旧值。
    const statusModel =
      readConfigSelectCurrentValue(activeTaskConfigOptions, "model") ??
      statusTask?.model ??
      formatBotModelSelectionValue(draftEffectiveSelection ?? undefined) ??
      "-";
    const statusModelLabel = await formatStatusModelLabel(statusModel, context);
    return (
      [
        formatStatusLine(locale, "statusWorkspace", workspace?.label ?? context.workspacePath),
        // Bugfix: active task 显示真实 task 状态；草稿态显示 draftOptions。
        // /new 后草稿继承自当前 task，继续显示 "-" 会让用户误以为继承失败。
        formatStatusLine(locale, "statusModel", statusModelLabel),
        "------",
        statusTask
          ? formatStatusTaskLine(statusTask, msg(locale, "statusTask"))
          : formatStatusLine(locale, "statusTask", msg(locale, "statusDraft")),
        formatStatusLine(
          locale,
          "statusState",
          formatStatusStateValue(locale, statusTask ? taskStatus(statusTask) : "draft"),
        ),
        workedDurationMs !== null
          ? formatStatusLine(locale, "statusWorked", formatTaskRunningDuration(workedDurationMs))
          : null,
        latestProgress ? formatStatusLine(locale, "statusProgress", latestProgress) : null,
        // [权衡] 用 null 占位再 filter(Boolean) 而不是拼条件字符串：
        // 行顺序被固定，避免时长/进度时有时无导致面板行序抖动。
      ].filter(Boolean) as string[]
    ).join("\n");
  }

  async function handleHelp(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    // help 也走鉴权：群内成员看到的命令列表必须与他的实际权限一致（INV-01 的展示侧）。
    const auth = await withAuthorizedContext(message, "help");
    if (!auth.ok) {
      return auth.reply;
    }
    return [
      createOutbound(
        message.actor,
        buildHelpText(
          auth.locale,
          auth.bot,
          // 群内按 owner/member 分流：member 只能看到 help/status 与“@机器人提交需求”。
          auth.context.group
            ? message.actor.providerUserId === auth.context.group.ownerId
              ? "owner"
              : "member"
            : undefined,
        ),
      ),
    ];
  }

  // 帮助文本是“权限的可视化”：每一行都必须对应真实的命令白名单，
  // 否则用户会反复尝试被拒的命令，管理员会收到无意义的 @。
  function buildHelpText(
    locale: Locale | undefined,
    bot: Pick<BotConfig, "allowedCommands">,
    groupRole?: "owner" | "member",
  ): string {
    const lines = [msg(locale, "helpTitle")];
    if (groupRole) {
      lines.push(
        locale === "en-US"
          ? "Mention this bot to submit a request. /answer answers your active question."
          : "@当前机器人提交需求；/answer 回答自己发起请求中的问题。",
      );
      if (groupRole === "owner") {
        // 群管理命令是硬编码短清单：它们不属于 BOT_MENU_COMMAND_ORDER（那是
        // 可配置策略的命令集），新增管理命令时必须同步改这一行，否则面板缺项。
        lines.push("/enable · /disable · /task · /stop · /approve · /deny · /reconnect");
        // /history 读的是 workspace 级聊天记录，复用 workspace 开关做授权，
        // 不再单独加一个开关，避免两处策略不一致。
        if (bot.allowedCommands.workspace !== false) lines.push("/history on|off");
      }
    }
    for (const command of BOT_MENU_COMMAND_ORDER) {
      if (
        groupRole &&
        (command === "bind" ||
          command === "reply" ||
          (groupRole === "member" && command !== "help" && command !== "status"))
      )
        continue;
      // help/bind 不受 allowedCommands 约束：help 是发现入口，bind 的权限
      // 已由绑定码本身（管理员签发）保证；把 help 关掉会让用户失去所有自救途径。
      if (command === "help" || command === "bind") {
        lines.push(msg(locale, helpMessageByCommand[command]));
        continue;
      }
      if (bot.allowedCommands[command] === false) {
        continue;
      }
      lines.push(msg(locale, helpMessageByCommand[command]));
    }
    return lines.join("\n");
  }

  // 话题历史读取的“世代号”。三段拼接分别对应三种会让已读历史失效的事件：
  // 1) botHistoryEpoch：连接/凭据被重建，历史洪泛点已不可比；
  // 2) groupHistoryEpoch：群内 /history on|off 切换，读取范围变了；
  // 3) backgroundHistory.revision：有新的背景消息插入，checkpoint 位置需要重算。
  // 缺任一段都会把“旧世代已读”误判成“本轮已读”，导致任务缺少上下文（INV-04 的输入完整性）。
  function historyGeneration(context: BotContextState): string {
    const groupKey = JSON.stringify([context.botId, context.group?.chatId]);
    return `${botHistoryEpoch.get(context.botId) ?? 0}:${groupHistoryEpoch.get(groupKey) ?? 0}:${context.group?.backgroundHistory?.revision ?? ""}`;
  }

  // prepareGroupTopicHistory 为话题输入准备「补读的历史」，只回答要不要读与读哪些。
  // a) 这次是否需要读（世代未读 + 历史开关打开 + 有 threadId）；
  // b) 要读哪些（checkpoint 之后、排除已入库的消息）。
  // 注意：本函数不做授权决策，只读取；授权由 withAuthorizedContext 完成。
  async function prepareGroupTopicHistory(
    bot: BotConfig,
    message: BotInboundMessage,
    context: BotContextState,
  ) {
    // 调用方（消息主流程）保证群消息带 providerMessageId；话题历史必须以它锚定 checkpoint。
    const messageId = message.actor.providerMessageId!;
    if (!context.group) return {};
    let topicContext: import("@zcode/shared").BotTopicHistoryBatch | undefined;
    let historyError: unknown;

    const generation = historyGeneration(context);
    // 在异步读历史之前固定 revision，不能把等待期间的新背景误当成本轮已读。
    // 若放在 await 之后再取，readTopicHistory 返回的旧数据会被盖上“最新”的章，
    // 后面那段背景就再也不会被补读。
    const backgroundRevision = context.group.backgroundHistory?.revision;
    let historyDisabled = false;
    const inputThreadId = message.actor.threadId ?? context.group.threadId;
    const inputRootMessageId = message.actor.rootMessageId ?? context.group.rootMessageId;
    if (inputThreadId) {
      // 历史开关属于“群默认记录”，话题只继承；因此必须读持久态而不是手里的 context，
      // context 可能是话题创建时复制下来的快照（INV-02 的投影口径）。
      const parent = (await repo.readState()).bots[
        getBotConversationKey({
          botId: bot.id,
          chatType: "group",
          chatId: context.group.chatId,
        })
      ];
      historyDisabled = parent?.group?.historyEnabled === false;
      // 同一世代只补读一次：否则话题里每句话都会重拉整段历史，既慢又会让任务
      // 反复看到同一批旧消息。世代号变化（换连接/切开关/新背景）才允许重读。
      if (!historyDisabled && topicHistoryReady.get(getBotStateKey(context)) !== generation) {
        const accepted = Object.values(context.group.inputs ?? {}).filter(
          (input) => input.admission === "accepted" && input.source.threadId === inputThreadId,
        );
        // checkpoint 是“已经进入任务的消息水位”：
        // 有背景历史时以背景检查点为准（它可能比输入更靠后），
        // 否则取本话题最后一条 accepted 输入的消息 id。
        const checkpoint = context.group.backgroundHistory
          ? context.group.backgroundHistory.checkpoint
          : accepted.at(-1)?.source.messageId;
        try {
          const reader = providers[bot.provider]?.readTopicHistory;
          // [失败路径] 走 throw 而不是 return：两条异常都意味着“无法保证历史完整”，
          // 必须与“确实没有新历史”区分开（后者返回空 batch 即可）。
          if (!reader || !inputRootMessageId) throw new Error("Topic history reader unavailable");
          topicContext = await reader(bot, {
            chatId: context.group.chatId,
            threadId: inputThreadId,
            rootMessageId: inputRootMessageId,
            messageId,
            checkpoint,
          });
          // 分批消息可能已在其它回调里作为独立输入入库；这里按 messageId 反查，
          // 把已经被任务消费过的原文从历史里剔除，避免同一句话被注入两次。
          const ingested = new Set(
            accepted.flatMap(
              (input) =>
                input.source.messages?.map((original) => original.messageId) ?? [
                  input.source.messageId,
                ],
            ),
          );
          // 当前消息的根引用单独走 conversationQuotes，不在历史里重复出现。
          topicContext.messages = topicContext.messages.filter(
            (item) => !ingested.has(item.id) && item.id !== message.referencedMessage?.messageId,
          );
        } catch (error) {
          botsLogger.warn(
            undefined,
            `topic history preparation failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          // 读取失败必须阻止提交，不能用缺口附件替代必需历史后启动任务。
          // topicContext=undefined + historyError 一起返回，调用方据此回错并释放投递（INV-03）。
          topicContext = undefined;
          historyError = error || new Error("Topic history unavailable");
        }
      }
    }
    return {
      topicContext,
      historyError,
      historyDisabled,
      generation,
      backgroundRevision,
    };
  }

  // 群输入 admission 的唯一入口（INV-03 / INV-04）。
  // 时序：确定性 commandId → 重新校验授权 → 合并附件/引用 → 预写 pending → 提交 CLI
  //       → 按 ack 落 accepted/rejected → 刷新话题状态与表情 → 队列卡。
  // 任何一步抛错都会冒泡到 handleInboundMessage，由它归还 inbound delivery，
  // 因此这里不需要（也不应该）自己做重试。
  async function submitGroupMessage(
    bot: BotConfig,
    message: BotInboundMessage,
    context: BotContextState,
    prepared: PreparedBotMessageContent,
    locale: Locale | undefined,
    history: Awaited<ReturnType<typeof prepareGroupTopicHistory>>,
    topicBatch?: PreparedTopicMessage[],
    isCurrent = () => true,
  ): Promise<BotOutboundMessage[]> {
    // 三个前置条件任一缺失都说明调用方路由错了；直接抛错而不是补一个默认值，
    // 否则会在错误的任务/错误的 provider 上写入不可回滚的输入。
    if (!context.group || !context.activeTaskId || !isFeishuBotProvider(bot.provider))
      throw new Error("Group context is missing");
    const service = await resolveZCodeTaskServiceForContext(context);
    if (!service.submitBotGroupInput)
      // 老 runtime 没有 admission API：不能退化成“直接发消息”，那会绕过 CLI 的
      // CommandInbox 串行化，产生两套排队的第二副本（文件头约定禁止）。
      throw new Error("Runtime does not support group input admission");
    const messageId = message.actor.providerMessageId;
    if (!messageId) throw new Error("Group message ID is required");
    // 幂等键必须由 provider 消息 id 推导（botId+chatId+messageId），不能随机：
    // provider 重投时 commandId 相同，CLI 才能把它识别为 duplicate 而不是新输入。
    const commandId = botGroupCommandId(bot.id, context.group.chatId, messageId);
    const { topicContext } = history;
    const inputThreadId = message.actor.threadId ?? context.group.threadId;
    const inputRootMessageId = message.actor.rootMessageId ?? context.group.rootMessageId;
    // 历史/附件准备期间控制通道可以停用群；不能用准备前的授权继续提交。
    // [并发] 重新读持久态而不是复用入参 context：入参可能是几百毫秒前的快照，
    // 期间管理员可能已经 /disable、换绑或切换了 activeTaskId。
    const admissionContext = (await repo.readState()).bots[getBotStateKey(context)];
    const admissionBot = findBot(await repo.readConfig(), bot.id);
    if (
      !admissionContext?.group?.enabled ||
      !admissionBot?.enabled ||
      admissionContext.group.ownerId !== admissionBot.providerUserId ||
      admissionContext.group.authorizationId !== context.group.authorizationId ||
      admissionContext.activeTaskId !== context.activeTaskId
    )
      // 五项逐一对应一种撤销：群禁用、bot 禁用、换绑、授权轮换、任务切换。
      // 只要有一项变了，这条输入就属于“旧授权”，必须拒绝而不是落到新任务上。
      throw new Error("Group authorization changed before input admission");
    let attachmentOffset = 0;
    const admittedAttachments: ZCodePromptAttachment[] = [];
    // 多个回调可能在首次接收前已各自准备根引用；提交时再按权威记录去重。
    // 这里从持久态判定“根引用是否已入库”，而不是用本轮 topicBatch 的局部变量：
    // 前一次提交可能已经 accepted，但当前 context 还没被刷新到最新。
    let rootIncluded = Object.values(admissionContext.group.inputs ?? {}).some(
      (input) => input.admission === "accepted",
    );
    const messages = topicBatch?.map(({ message: original, prepared: material }) => {
      const quote = original.referencedMessage;
      const isRoot = !!inputRootMessageId && quote?.messageId === inputRootMessageId;
      const includeQuote = quote && !(isRoot && rootIncluded);
      const attachmentIndexes: number[] = [];
      let hasRootAttachment = false;
      material.zcodeAttachments.forEach((attachment, index) => {
        const resourceMessageId =
          original.attachments?.[index]?.providerMetadata?.resourceMessageId;
        const rootAttachment = !!inputRootMessageId && resourceMessageId === inputRootMessageId;
        hasRootAttachment ||= rootAttachment;
        // 根引用可能在上一轮接收前就已下载；提交时同时去重资源，不能只隐藏引用正文。
        // 漏掉这一步会让同一份文件在任务里出现两次（引用正文隐藏了，附件却还在）。
        if (rootAttachment && rootIncluded) return;
        // attachmentIndexes 是“在最终附件数组里的下标”，不是在本条消息内的下标：
        // 合批后 CLI 只认一个扁平附件数组。
        attachmentIndexes.push(admittedAttachments.length);
        admittedAttachments.push(attachment);
      });
      // 推进偏移量，供函数末尾把剩余（历史文本）附件追加到各消息之后。
      attachmentOffset += material.zcodeAttachments.length;
      // 根正文与根附件任一被纳入，就认为根已被消费，后续消息不再重复。
      if ((isRoot && includeQuote) || hasRootAttachment) rootIncluded = true;
      return {
        // topicBatch 的每条都来自 provider 事件，providerMessageId 必然存在。
        messageId: original.actor.providerMessageId!,
        senderId: original.actor.providerUserId,
        mentionedBot: original.mentionedBot === true,
        contentParts: original.contentParts,
        // displayName 只做展示，缺失时回退到 id，不能留空字符串（协议要求 min(1)）。
        senderName: original.actor.displayName ?? original.actor.providerUserId,
        text: original.text,
        ...(includeQuote ? { conversationQuotes: [quote] } : {}),
        attachmentIndexes,
      };
    });
    // 历史文本附件在各条原始附件之后追加，保留它且不归给后续消息。
    if (topicBatch) admittedAttachments.push(...prepared.zcodeAttachments.slice(attachmentOffset));
    const source = {
      // authorizationId 让 CLI 侧也能判断“这条输入属于哪一次群授权”，
      // 与 commandId 一起构成双重幂等边界。
      authorizationId: context.group.authorizationId,
      botIdentity: { name: bot.name, ...(message.botOpenId ? { openId: message.botOpenId } : {}) },
      provider: bot.provider,
      botId: bot.id,
      chatId: context.group.chatId,
      threadId: inputThreadId,
      rootMessageId: inputRootMessageId,
      appId: bot.feishuAppId,
      contentParts: message.contentParts,
      senderId: message.actor.providerUserId,
      mentionedBot: message.mentionedBot === true,
      senderName: message.actor.displayName ?? message.actor.providerUserId,
      messageId,
      ...(messages ? { messages } : {}),
      ...(topicContext ? { topicContext } : {}),
    };
    // 必须在写入 pending 之前计算：写入后再查，inputs 里已经有本条记录，
    // “首次输入”将永远为 false，任务标题也就永远不会被设置。
    const isFirstTaskInput = !Object.values(context.group.inputs ?? {}).some(
      (input) => input.taskId === context.activeTaskId,
    );
    // 乐观预写 pending：CLI 的事件可能先于 admission ack 到达，先有记录
    // 才能让流事件找到归属的 input（INV-02：写仍走 writeContext 的串行合并）。
    context.group = {
      ...context.group,
      inputs: {
        ...context.group.inputs,
        [commandId]: { taskId: context.activeTaskId, source, admission: "pending" },
      },
    };
    await writeContext(context);
    // 先挂流再提交：若提交后事件立即到达，watch 已经就绪，不会丢首帧。
    await watchTaskStream(bot, message.actor, context, { ...bot, replyMode: "summary_changes" });
    // 原文已经寄存为文本附件；不能再通过来源元信息把整份历史塞进 command frame。
    // topicContext 的 checkpoint 必须等于 messageId（协议校验），而这里 messageId
    // 是最新消息，直接把整段历史塞进去会与附件内容重复。
    const { topicContext: archive, ...runtimeSource } = source;
    // 已被后继消息取代（合批边界变化/停止）时不再提交，避免同一轮出现重复输入。
    // 代价是上面预写的 pending 记录会留在 inputs 里，终态只能依赖后继提交或停止流程收敛。
    if (!isCurrent()) return [];
    const ack = await service.submitBotGroupInput({
      taskId: context.activeTaskId,
      commandId,
      content: prepared.content,
      // 引用只在两种互斥场景下出现：合批（每条消息自带引用）或单条消息（原引用）。
      // 合批时不再追加顶层引用，否则根消息的引用会被重复计入两次。
      ...(topicBatch
        ? {
            conversationQuotes: messages?.flatMap((entry) => entry.conversationQuotes ?? []) ?? [],
          }
        : message.referencedMessage
          ? { conversationQuotes: [message.referencedMessage] }
          : {}),
      attachments: topicBatch ? admittedAttachments : prepared.zcodeAttachments,
      source: {
        ...runtimeSource,
        // topicHistory 只下发“轻量索引”（检查点、是否有缺口、条数、资源计数），
        // 原文与附件已由 Host 归档，CLI 不需要也不应该再收一份全文。
        ...(archive
          ? {
              topicHistory: {
                checkpoint: archive.checkpoint,
                hasGap: archive.hasGap,
                messageCount: archive.messages.length,
                resourceMessages: archive.messages
                  .filter((record) => record.attachments?.length)
                  .map((record) => ({ messageId: record.id, count: record.attachments!.length })),
              },
            }
          : {}),
      },
    });
    if (ack.status !== "accepted" && ack.status !== "duplicate") {
      // 被拒必须落成 rejected 终态再抛错：如果只抛错不写状态，
      // inputs 会永远停在 pending，队列卡/表情也无法收敛（INV-04）。
      // 第三个参数 expectedTaskId 保证这次回写只作用于提交时的那个任务。
      context.group.inputs![commandId]!.admission = "rejected";
      await writeContext(context, false, context.activeTaskId);
      throw new Error(ack.message ?? ack.reasonCode ?? "Input rejected");
    }
    // accepted/duplicate 仍要校验 result 形状：result 缺失说明 runtime 协议版本不匹配，
    // 此时后续的 delivery 分支无从判断，宁可失败也不能猜一个默认值。
    if (ack.result?.type !== "inputAccepted") throw new Error("Input admission outcome is unknown");
    // 走到这里输入已被 CLI 接受；提醒管理员“有输入待处理”的意义消失。
    adminAttention.clear(message.actor, bot.providerUserId);
    context.group.inputs![commandId]!.admission = "accepted";
    // 话题一旦有输入成功入库，就进入 active 状态（之后普通消息才会继续路由到它）。
    if (context.group.threadId) context.group.topicActive = true;
    await writeContext(context, false, context.activeTaskId);
    // 只有本轮仍是当前输入时才推进已读世代，否则会把“被后继消息取代的读取”
    // 误标为已完成，后继消息就再也不会补读历史。
    if (context.group.threadId && isCurrent() && history.generation) {
      topicHistoryReady.set(getBotStateKey(context), history.generation);
    }
    if (context.group.threadId && isCurrent()) {
      // [并发] 这段必须串行执行：它同时改 topicActive、backgroundHistory 与跨话题
      // topicAliases，且要基于“读到的这一刻”的最新状态判断是否清除检查点。
      await serializeStateWrite(async () => {
        const state = await repo.readState();
        const current = state.bots[getBotStateKey(context)];
        if (current?.group && isCurrent()) {
          current.group.topicActive = true;
          // 只清除本轮已补读且没有被新背景替换的检查点；准备期间来的背景留给下一轮。
          // 若 revision 已变化还删除，新增背景会被永久丢失（下一次世代判断不会重读）。
          if (
            history.topicContext &&
            history.backgroundRevision &&
            current.group.backgroundHistory?.revision === history.backgroundRevision
          ) {
            delete current.group.backgroundHistory;
            topicHistoryReady.set(getBotStateKey(current), historyGeneration(current));
          }
        }
        for (const candidate of Object.values(state.bots)) {
          if (candidate.botId === bot.id && candidate.group?.chatId === context.group!.chatId) {
            // 别名用于把“旧话题”上的后续消息接续到已有任务；本话题已成功入库后，
            // 别名不再需要，留着反而会把新消息路由回旧任务。
            delete candidate.group.topicAliases?.[context.group!.threadId!];
          }
        }
        await repo.writeState(state);
      });
    }
    if (isFirstTaskInput && service.renameTask) {
      await service
        .renameTask({
          taskId: context.activeTaskId,
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          title: `${bot.provider === "lark" ? "Lark" : "飞书"} · ${context.group.name}${context.group.threadId ? ` · ${context.group.topicTitle || context.group.threadId}` : ""}`,
        })
        .catch((error: unknown) => {
          // 输入已经被 CLI 接受，标题写入失败不能释放去重并重新执行输入。
          // 标题只是可读性增强，失败后保持默认标题即可（INV-04 的终态优先）。
          botsLogger.warn(
            undefined,
            `persist group task title failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    // 表情语义：排队 → waiting（黄），直接执行 → working（进行中）。
    // delivery 由 CLI 决定，这里只是把权威结果投影到消息上。
    await updateGroupInputReaction(
      bot,
      context,
      messageId,
      ack.result.delivery === "queue" ? "waiting" : "working",
    );
    const replies =
      ack.result.delivery === "queue" && !context.group?.threadId
        ? [
            createOutbound(
              message.actor,
              locale === "en-US" ? "Waiting to run" : "等待执行",
              {
                // INV-11：卡片 id 与按钮 payload 都必须能反解出 commandId，
                // 回调处理端靠 `/queue-cancel <id>` 定位到具体输入。
                id: `queue-${commandId}`,
                title: locale === "en-US" ? "Queued" : "已排队",
                action: "queue.cancel",
                // 群默认任务不提供卡片上的取消按钮（showCancel=false），取消走
                // `/queue-cancel` 回调，以便携带 sourceCommandId 做归属校验。
                showCancel: false,
                options: [
                  {
                    id: `/queue-cancel ${commandId}`,
                    label: locale === "en-US" ? "Cancel" : "取消",
                  },
                ],
              },
              { locale, groupSourceCommandId: commandId, groupTaskId: context.activeTaskId },
            ),
          ]
        : [];
    // 话题不返回队列卡：话题内的进度由表情与话题卡表达，再发一张卡会造成两套状态。
    return replies;
  }

  // 把 input admission 结果投影到 IM 表情与队列卡。整条链路都是“尽力而为”：
  // 任何失败只记日志，不允许反推输入失败（INV-04：终态由 CLI 决定，不由展示层决定）。
  async function updateGroupInputReaction(
    bot: BotConfig,
    context: BotContextState,
    messageId: string | undefined,
    state: BotGroupInputStatus,
  ): Promise<void> {
    if (!messageId) return;
    try {
      // 反查 input 用 source.messageId 而不是 commandId：调用方手里只有 provider 消息 id。
      const entry = Object.entries(context.group?.inputs ?? {}).find(
        ([, input]) => input.source.messageId === messageId,
      );
      const inputId = entry?.[0];
      if (inputId && context.group) {
        await queueCards
          .update(
            // 队列卡 key 必须包含授权与任务维度：群被重新授权或任务切换后，
            // 旧卡片不能被新输入复用（否则会把新进度渲染到旧卡上）。
            JSON.stringify([
              bot.id,
              context.group.chatId,
              context.activeTaskId,
              context.group.authorizationId,
              inputId,
              context.group.threadId,
            ]),
            state,
          )
          .catch((error) => {
            // 卡片是投影：更新失败只影响观感，不能让它冒泡成业务失败。
            botsLogger.warn(
              undefined,
              `queue card update failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      // CLI 终态可能早于 admission ACK；表情必须采用保存后的单向状态。
      // 否则会出现“任务已完成，表情还停在 working”，且后续没有事件再纠正。
      if (inputId) {
        const latest = (await repo.readState()).bots[getBotStateKey(context)];
        state = latest?.group?.inputs?.[inputId]?.progress?.status ?? state;
      }
      // 合批只合并执行，表情仍属于每条原消息，不能只更新最后一条。
      const messageIds = entry?.[1].source.messages?.map((message) => message.messageId) ?? [
        messageId,
      ];
      await Promise.all(
        messageIds.map((originalId) =>
          providers[bot.provider]?.updateInputReaction?.(
            bot,
            originalId,
            // provider 的表情集合里没有 stopped/discarded，统一映射成 cancelled；
            // 不映射会退回默认表情，让“已停止”看起来像“还在跑”。
            state === "stopped" || state === "discarded" ? "cancelled" : state,
          ),
        ),
      );
    } catch (error) {
      // 表情只是状态投影；平台失败不能把已接受输入变成失败或触发重跑。
      botsLogger.warn(
        undefined,
        `group input reaction update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 取消“还在队列里”的群输入。它只处理排队卡回调，真正的停止由 /stop 负责。
  async function cancelGroupInput(
    message: BotInboundMessage,
    sourceCommandId: string,
  ): Promise<BotOutboundMessage[]> {
    // 用 "message" 作为命令类型：它是成员可用命令，具体归属在下面用 input 自身校验。
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    const group = auth.context.group;
    const input = group?.inputs?.[sourceCommandId];
    // 旧话题排队卡可能仍留在飞书，不能让它操作新话题的停止续接输入。
    // 话题模式下排队语义由话题自己管理，直接回 toast 失效，避免跨话题取消。
    if (group?.threadId) {
      return [
        {
          ...createOutbound(
            message.actor,
            auth.locale === "en-US"
              ? "This topic queue card has expired. Use /stop to stop the topic."
              : "该话题排队卡已失效，请使用 /stop 停止话题。",
          ),
          callbackToastOnly: true,
        },
      ];
    }
    if (
      !group ||
      !input ||
      // 任务切换后，旧卡的 commandId 仍能查到记录，但已不属于当前任务：必须拒绝，
      // 否则会取消掉新任务里同名的输入（inputs 是跨任务累积的）。
      input.taskId !== auth.context.activeTaskId ||
      // 只有 owner 或这条输入的原发送者能取消它；其他人的点击视为越权。
      (message.actor.providerUserId !== group.ownerId &&
        input.source.senderId !== message.actor.providerUserId)
    ) {
      return [
        {
          // 归属校验失败但目标存在 → 是“别人的卡片”，提醒管理员而不是直接报错。
          ...(group && input && input.taskId === auth.context.activeTaskId
            ? administratorReply(
                message.actor,
                auth.bot,
                `queue-cancel:${sourceCommandId}`,
                createOutbound(message.actor, msg(auth.locale, "groupOwnerOnly")),
              )
            : createOutbound(message.actor, msg(auth.locale, "groupOwnerOnly"))),
          callbackToastOnly: true,
        },
      ];
    }
    const taskService = await resolveZCodeTaskServiceForContext(auth.context);
    if (!taskService.cancelBotGroupInput) throw new Error("Runtime cannot cancel queued input");
    const ack = await taskService.cancelBotGroupInput({
      taskId: input.taskId,
      // 取消命令自身也要幂等：重复点击会产生同一个 commandId，CLI 回 duplicate，
      // 因此不会出现“第二次取消把别的东西也取消了”。
      commandId: `cancel-${sourceCommandId}-${message.actor.providerMessageId}`,
      sourceCommandId,
      actorId: message.actor.providerUserId,
      ownerId: group.ownerId,
      botId: auth.bot.id,
      chatId: group.chatId,
    });
    const accepted = ack.status === "accepted" || ack.status === "duplicate";
    if (accepted)
      // duplicate 说明本来就已经取消过；仍然刷新表情，保证展示与权威状态一致。
      await updateGroupInputReaction(auth.bot, auth.context, input.source.messageId, "cancelled");
    return [
      createOutbound(
        message.actor,
        // 未接受不是错误：输入可能刚好开始执行或已被合并，
        // 如实告知“未取消”比报错更准确，也不会误导用户重复点击。
        accepted
          ? auth.locale === "en-US"
            ? "Queued input cancelled."
            : "已取消该排队输入。"
          : auth.locale === "en-US"
            ? "Input changed or started; cancellation was not applied."
            : "输入已变化或开始执行，未取消。",
      ),
    ];
  }

  function sendPromptInBackground(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    taskId: string,
    traceId: string,
    content: string,
    attachments: ZCodePromptAttachment[],
    botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget,
    modelSelection?: ModelSelection,
  ): void {
// sendPromptInBackground：把一次已接受的输入投递给 runtime，并故意不返回 Promise。
// 为什么 fire-and-forget：Telegram 入站是单循环顺序处理 update，await 整轮会让 /permission
// 回调排在任务结束之后，用户点 inline keyboard 毫无反应；失败后果全部由下面的 catch 收尾：
// 清 runningTasks/Typing、广播 error 终态、回一条可读的失败消息（INV-04：accepted 输入必须有终态）。
// 副作用：写 trace 集合、唤醒订阅、启动 Typing、跨进程发送 prompt、失败时广播与外发。
    privateImTraces.add(JSON.stringify([taskStreamKey(context, actor), traceId]));
// [并发] 先登记 trace 再派发：stream 事件可能早于 sendPrompt 的 resolve 回来，若反过来写，
// 首屏卡片更新会被当成“非本轮输入”丢弃，用户看不到流式反馈。
// imInput() 只是把常驻私聊订阅标记为“正在等输入”，不重建订阅；没有订阅时静默跳过。
    streamSubscriptions.get(taskStreamKey(context, actor))?.imInput();
    // 私聊常驻订阅不再随每轮建立；必须在本次输入派发前接管 Typing，
    // 否则回调收尾会将它当作短命令表情立即删除。终态/交互等待沿用原清理路径。
// 群聊的 Typing 由队列卡与输入回执管理；这里若也接管，会与卡片状态互相覆盖。
    if (!context.group) startTyping(bot, actor, taskId);
    // Bugfix: Telegram polling 是单循环顺序处理 update。如果这里 await session/prompt，
    // 权限按钮 callback 会一直排队到整轮任务结束，导致用户点 inline keyboard 没反应。
    // 因此 prompt 必须后台跑，polling loop 才能继续接收 /permission 回调。
// [失败路径] 解析 service 与 sendPrompt 放在同一条 then 链：任何一步拒绝都进下面的 catch。
// `void` 表示有意丢弃返回的 Promise，但链尾必须挂 catch，否则会变成 unhandledRejection 拖垮进程。
// [权衡] 不改用 await + 后台队列：那需要额外调度器与背压，而这里需要的只是“立即返回”。
    void resolveZCodeTaskServiceForContext(context)
      .then((zcodeTaskService) =>
        zcodeTaskService.sendPrompt({
          taskId,
          traceId,
          content,
          attachments: attachments.length > 0 ? attachments : undefined,
          botDeliveryTarget,
          modelSelection,
        }),
      )
// [失败路径] 两类错误文本口径不同：message 是诊断原文，进 broadcast 给 UI 与日志；
// userFacingMessage 经 formatUserFacingBotError 本地化，只进 IM，避免把内部错误甩给用户。
// locale 在失败时才读：派发前读会把当时的语言固化，用户中途切换语言就得不到新文案。
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const locale = await readMessageLocale();
        const userFacingMessage = formatUserFacingBotError(error, locale);
// 先撤 running 再广播：getContextTaskBlockReason 以 runningTasks 为证据，
// 顺序反了会出现“已报错但 /task 仍说运行中”的窗口，用户要等下一轮才能切换。
// [资源] 停 Typing 必须走 stopTyping（清 interval 与目标映射），不能只删标记。
        runningTasks.delete(taskId);
        stopTyping(taskId);
// 终态广播是 UI 侧的权威收尾：不广播会让侧栏永远停在 running，
// 而本文件不持有 conversation 正文事实，无法靠本地改写状态补救（INV-04）。
        await broadcastTaskListChange(context, taskId, "error", {
          error: message,
        });
        await sendOutbound(
          bot,
          createOutbound(
            actor,
// 会话过期本身就是完整可执行的提示（重新建立会话），再套“任务失败”模板会掩盖处置方式。
// 外发失败只吞掉：此刻终态已广播，回复发不出去也不能反过来改状态或重跑整轮。
            isSessionExpiredError(error)
              ? userFacingMessage
              : msg(locale, "taskFailed", { message: userFacingMessage }),
          ),
        ).catch(() => undefined);
      });
  }

// stopTopicRun：停止话题里指定的某次 execution，并把对应的用户输入投影标成 stopped。
// 身份三元组 (workspaceKey, taskId, executionId) 缺一不可：同一 taskId 会被新 run 复用，
// 只用 taskId 会让迟到的停止请求误杀刚开始的新轮。
// 副作用：一次 stop RPC、一次（可选）状态写入 + 广播。等待终态由 runtime 实现完成
// （先注册 execution 结束监听再发 stop，并 await 该监听），本函数不再轮询、也不重复等待。
  async function stopTopicRun(
    context: BotContextState,
    executionId: string,
    sourceCommandId?: string,
  ): Promise<void> {
    const taskId = context.activeTaskId;
    if (!taskId) return;
    const key = JSON.stringify([
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      taskId,
      executionId,
    ]);
// [并发] 单飞去重：同一 execution 的并发停止（多条消息同时到达、准备重试）必须汇成一次 RPC。
// get 与 set 之间没有任何 await，事件循环单线程保证这一步仍是原子操作；
// 反例：两次 RPC 并发时，第二次可能在旧 run 已停、新 run 已启动之后才执行，从而停错 run。
    const existing = topicStops.get(key);
    if (existing) return existing;
    const stopping = resolveZCodeTaskServiceForContext(context).then(async (service) => {
// [失败路径] 能力缺失必须抛错而不是当作“已停止”：老 Host 没有该 RPC，
// 假装成功会让 continuation 直接提交新消息，与仍在运行的旧 run 并发写同一 context。
      if (!service.stopBotTopicExecution) throw new Error("Topic stop is unavailable");
      await service.stopBotTopicExecution({
        taskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
        executionId,
      });
// [事务] INV-02：输入状态属于 repo 的权威副本，写入必须经 serializeStateWrite 串行，
// 并在临界区内重新 readState 再改；拿停止前的快照回写会覆盖这段时间的并发 admission。
// sourceCommandId 来自 readRunningRun 的观察值：只有群里“某条消息触发的那次执行”才有对应 input。
      if (sourceCommandId)
        await serializeStateWrite(async () => {
          const state = await repo.readState();
          const latest = state.bots[getBotStateKey(context)];
          const input = latest?.group?.inputs?.[sourceCommandId];
          if (
            !input ||
            input.taskId !== taskId ||
            input.progress?.status === "done" ||
// [并发] 三重护栏：记录已清理、已属于另一个 task（commandId 被复用）、或早已终态时不改写。
// 省掉它们，迟到的 stop 回调会把 done/failed 的输入改成 stopped，用户看到的状态会倒退。
            input.progress?.status === "failed"
          )
            return;
          input.progress = {
            ...input.progress,
            status: "stopped",
            interruptionReason: "newMessage",
          };
          await repo.writeState(state);
        });
// 广播放在状态写入之后：UI 收到事件会重读 repo，顺序反了会先渲染旧状态再被覆盖。
// [失败路径] 这里的 send 是 await 的：广播抛错会让整个 stopping 拒绝，continuation 遂把材料标 failed，
// 但 stop 实际已成功——这是当前实现的风险点（只标注不改）。
      if (sourceCommandId)
        await deps.broadcastService?.send({ channel: "bots:group-state", payload: {} });
    });
// [并发] 先登记 promise 再返回：期间到达的调用方走上面的 existing 分支，共享同一个结果。
// release 的身份比较不可省：删除后可能已有新一代 stop 登记同 key，无脑 delete 会删掉别人的入口。
// `then(release, release)` 两条路径都释放，void 只吞掉派生 promise 的再拒绝（原始 stopping 仍向调用方抛）。
    topicStops.set(key, stopping);
    const release = () => {
      if (topicStops.get(key) === stopping) topicStops.delete(key);
    };
    void stopping.then(release, release);
    return stopping;
  }

// cancelGroupTopicInputs：群级撤销时取消该 bot+群下所有话题的待处理输入。
// 必须覆盖“还没有任务、只存在于内存准备阶段”的话题：这些输入没有 group.inputs 记录，
// 只扫 repo 会漏掉正在下载附件的消息，撤销后它们仍会被提交。
  async function cancelGroupTopicInputs(actor: BotActor): Promise<void> {
    // 群级撤销必须覆盖所有话题，包括尚未创建任务、仍在准备历史的输入。
// 两个来源取并集：repo 里的键是已持久化的会话，continuation 的键是“正在准备但尚未落盘”的会话；
// 任何一边缺失都会留下一批撤销不掉的输入。
    const states = (await repo.readState()).bots;
    const keys = new Set([...Object.keys(states), ...topicContinuations.keys()]);
    await Promise.all(
      [...keys].flatMap((key) => {
// 只处理群/话题键：getBotConversationKey 对私聊返回裸 botId，对群返回 JSON 数组，
// 前缀判断把私聊与历史遗留键排除在外，避免把私聊输入误当话题取消。
        if (!key.startsWith("[")) return [];
// key 全部由 getBotConversationKey 本地生成，格式受控，解析不会失败；
// threadId 必须存在：普通群会话是两元素数组，它的取消走原群输入路径，不能在这里重复处理。
        const [botId, chatId, threadId] = JSON.parse(key) as string[];
        return botId === actor.botId && chatId === actor.chatId && threadId
// 显式把 conversationThreadId 置空：getBotConversationKey 优先用它，若继承 actor 的值，
// 所有话题会塌缩到同一个键，只取消掉其中一个会话。
          ? [cancelTopicInputs({ ...actor, threadId, conversationThreadId: undefined })]
          : [];
      }),
    );
  }

// cancelTopicInputs：取消单个话题会话语境里的全部在途输入。顺序是有意的：
// 清准备投影 → 递增代际 → 失效历史缓存 → 取消 continuation → 兑现挂起的 reply promise
// → 标表情 → 通知 runtime 作废已入队输入 → 广播。没有 await 相隔的步骤靠事件循环保证原子。
  async function cancelTopicInputs(actor: BotActor): Promise<void> {
    const key = getBotConversationKey(actor);
// [并发] 代际号是唯一的栅栏：prepare 与 submit 的闭包都捕获旧 generation，递增后自行放弃
// （见 receive 回调与 submit 的 isCurrent）。换成布尔 cancelled 标记，取消后重新开始的新一轮
// 无法与上一轮区分，旧回调会污染新状态。
// 删除 topicHistoryReady 让下一轮强制重读历史，否则会以取消前的 checkpoint 认定“已读”而跳过。
    topicPreparation.clear(key);
    topicGenerations.set(key, (topicGenerations.get(key) ?? 0) + 1);
    topicHistoryReady.delete(key);
// [资源] continuation.cancel 会递增其内部 generation 并释放 cancellation，
// 让正在等待的 readRunningRun/stopAndWait/附件准备经 Promise.race 立即返回，不再继续提交。
    topicContinuations.get(key)?.cancel();
// 先快照 key 再 resolve：resolver 兑现后下面的 clear 会让后续遍历拿不到这些 id，而取消表情还要用。
// key 就是 providerMessageId（登记处见 receiveTopicMessage）。
// [失败路径] INV-04：取消必须给每个等待者一个终态，空数组表示“不回复”，
// 否则入站链会永远 await result，Typing 与队列卡也停不下来。
    const cancelledIds = [...(topicReplies.get(key)?.keys() ?? [])];
    for (const resolve of topicReplies.get(key)?.values() ?? []) resolve([]);
    topicReplies.get(key)?.clear();
// 重读持久状态与配置：取消期间可能发生 /workspace 切换、群被禁用或 bot 被删除，
// 用调用方传入的 actor 推断会给错误 context 打表情。
    const context = (await repo.readState()).bots[key];
    const bot = findBot(await repo.readConfig(), actor.botId);
    if (context && bot) {
      await Promise.all(
// updateGroupInputReaction 内部对队列卡与平台表情都 try/catch，因此单条表情失败不会中断
// 后续的 runtime 失效；反过来也意味着表情失败是静默的（只 warn）。
        cancelledIds.map((id) => updateGroupInputReaction(bot, context, id, "cancelled")),
      );
    }
    if (context?.activeTaskId) {
      const service = await resolveZCodeTaskServiceForContext(context);
// [失败路径] 此时本地投影已清、promise 已兑现，但 runtime 里可能仍有排队输入。
// 抛错而不是假装成功，让调用方知道存在“本地已取消、远端未取消”的半状态并重试。
      if (!service.invalidateBotTopicInputs)
        throw new Error("Topic preparation cancellation is unavailable");
      await service.invalidateBotTopicInputs({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
// 广播放在最后：上面的 capability guard 若抛错，这个 await 不会到达，UI 仍显示“准备中”。
// 即失败时投影与事实会短暂偏差，需要调用方重试纠正（风险点，只标注）。
        workspaceIdentity: context.workspaceIdentity,
      });
    }
    await publishTopicPreparation();
  }

// admitAutoReplyTurn：机器人互答闸门。返回 false 表示“静默丢弃”，调用方不回任何消息（见 processInbound）。
// 因此每次误判都表现为“用户消息消失”，规则必须偏向放行真人、只拦机器人。
// 它也是额度计数的唯一写入点：占用必须与去重一起持久化，否则重投/并发/重启都能绕过 5 轮上限。
  async function admitAutoReplyTurn(message: BotInboundMessage): Promise<boolean> {
    if (
      message.actor.chatType !== "group" ||
// 卡片回调与 elicitation 回答是用户显式交互，不是自动回复，不能被额度吞掉（INV-04：交互必须能被消费）。
// 非群聊没有 bot 互答场景，不受群额度约束，所以直接放行。
      message.groupCardAction ||
      message.elicitationResponse
    )
      return true;
// 没有消息 id 就无法做幂等/去重，只能按发送者类型取舍：
// 真人放行（宁可执行一次），app 丢弃（否则两台机器人可以无 id 地无限互答）。
    const id = message.actor.providerMessageId;
    if (!id) return message.senderType !== "app";
    let admitted = false;
    // 新消息 ID 去重不足以阻断两台机器人互答。必须在停止/准备前原子占用次数，
    // 与去重一起持久化；准备失败仍占一次，避免重投、并发和重启绕过上限。
// [并发] INV-02：额度、去重与 stop/准备共用同一把写锁。若先读内存计数再异步写，
// 同一毫秒到达的两条消息会读到相同 consecutive，双双通过上限判断。
// 键含 threadId：额度按话题/会话计，一个活跃话题不会耗尽整个群的额度。
    await serializeStateWrite(async () => {
      const state = await repo.readState();
      const context = state.bots[getBotConversationKey(message.actor)];
      const group = context?.group;
// 群未启用时没有可信授权上下文（INV-01 只认 BotGroupSource），机器人消息直接丢弃；
// 真人仍放行，让 withAuthorizedContext 回一条“群未启用”的可行动反馈，而不是静默消失。
      if (!group?.enabled) {
        admitted = message.senderType !== "app";
        return;
      }
// 二次校验 owner：群状态的 ownerId 是持久事实，配置里的 providerUserId 可能已改绑；
// 不一致说明授权失效，任何发送者都不放行，避免用旧授权执行任务。
      const bot = findBot(await repo.readConfig(), message.botId);
      if (!bot?.enabled || bot.providerUserId !== group.ownerId) return;
// 首次交互（尚无 guard）时真人的控制命令不占额度：/status、/stop 必须永远可用，
// 否则互答把额度打满后用户连停都停不下来。只对 !autoReplyGuard 生效。
      if (
        !group.autoReplyGuard &&
        message.senderType !== "app" &&
        parseBotCommand(message.commandText ?? message.text).type !== "message"
      ) {
        admitted = true;
        return;
      }
// guard 口径：consecutive 只累计 app 连续轮次（真人插话即归零）；messageIds 已消费额度的消息 id，
// 用于重投去重。缺省值不写回状态，只有真正占用时才创建。
      const guard = group.autoReplyGuard ?? { consecutive: 0, messageIds: [] };
// [并发] 双源判重缺一不可：guard 记录“额度已花”，inputs 记录“admission 已发生”，
// 两者会在不同失败点分叉（准备失败时只有 guard，命令路径可能只有 input）。
// 命中后仍按发送者类型放行真人重试，但绝不再 +1 额度（否则重试会把互答上限顶回去）。
      if (
        guard.messageIds.includes(id) ||
        Object.values(group.inputs ?? {}).some(
          (input) =>
            input.source.messageId === id ||
            input.source.messages?.some((original) => original.messageId === id),
        )
      ) {
        // 真人重试仍走原有准备/命令幂等流程，但不能重复恢复机器人额度。
        admitted = message.senderType !== "app";
        return;
      }
// [权衡] 5 是硬编码上限，用于打断 A↔B 两台机器人的乒乓；没有它，两个自动回复的 bot
// 会以消息往返速度无限烧 token。不放进配置，因为它属于安全阀而不是业务参数。
// 另外要求“对方确实在跟我说话”：话题内必须 topicActive，非话题必须 @ 到我。
      if (
        message.senderType === "app" &&
        (guard.consecutive >= 5 ||
          (message.actor.threadId ? group.topicActive !== true : message.mentionedBot !== true))
      )
        return;
// [事务] 在同一临界区内改副本再落盘；落盘失败会直接抛出，admitted 保持 false（消息丢弃），
// 宁可失败也不在没有持久额度的情况下执行。
// messageIds 只增不减，长期活跃群会持续增长（无裁剪），这是可观测的状态膨胀点。
      group.autoReplyGuard = {
        consecutive: message.senderType === "app" ? guard.consecutive + 1 : 0,
        messageIds: [...guard.messageIds, id],
      };
      await repo.writeState(state);
      admitted = true;
    });
// 返回值就是最终裁决：调用方拿到 false 时不回消息也不写状态，
// 因此上面每条 return 都必须已经决定好 admitted，不能留下默认真值的路径。
    return admitted;
  }

// receiveTopicMessage：话题消息的唯一入口。它把同一话题的并发消息合并成一次提交，
// 并在提交前停止正在运行的旧 run（stop → 等终态 → 提交新批次）。
// 返回“这条消息应回的文本”，由调用方负责外发；合批时只有批次身份那条拿到回复，其余为 []。
// [并发] 每个会话一个 continuation，负责串行化“停止 + 提交”；本函数只做登记与去重。
// 本文件不建第二份 accepted queue：真正的 admission 仍由 handleMessage → CLI 完成。
  async function receiveTopicMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const key = getBotConversationKey(message.actor);
    const id = message.actor.providerMessageId;
// [失败路径] 没有 providerMessageId 既无法去重也无法更新表情，抛错让上层记日志并放弃，
// 比“冒险执行一次”安全（INV-03：幂等键必须先占位）。
    if (!id) throw new Error("Topic message identity is missing");
    // 去重必须早于停止副作用；重投的已接收事件不能打断正在运行的新轮。
// 先查持久化的 admission 记录：CLI 或本进程重启后内存表已空，
// 只有 repo 里的 inputs（含合批的 source.messages）能证明这条消息已被接收过。
    const stored = (await repo.readState()).bots[key];
    if (
      Object.values(stored?.group?.inputs ?? {}).some(
        (input) =>
          input.source.messageId === id ||
          input.source.messages?.some((original) => original.messageId === id),
      )
    )
      return [];

// [资源] 按会话懒建“等待回复”表，键为 providerMessageId；continuation settle 后由下面 finally 清理。
    let replies = topicReplies.get(key);
    if (!replies) {
      replies = new Map();
      topicReplies.set(key, replies);
    }
    // 持久化接收去重在 handleMessage；这里只合并同时到达的同一事件。
// [并发] 必须先登记 resolver 再调用 receive：submit/failed 是异步回调，可能先完成，
// 那时 `pendingReplies.get(id)?.()` 会 miss，调用方将永远等不到 result（INV-04）。
// 内存去重只覆盖“同一事件被并发投递两次”，跨重启的去重靠上面的持久判重。
    if (replies.has(id)) return [];
    const pendingReplies = replies;
    const result = new Promise<BotOutboundMessage[]>((resolve) => pendingReplies.set(id, resolve));
// 每个会话语境固定一个 continuation：它内部持有 pending 材料队列与取消代际，重建会丢掉
// 正在等待停止的批次。continuationGeneration 是创建时的代际快照，供迟到的 stop/下载异常
// 判断“我已不是当前这一代”。current() 每次都重读 repo，避免把结果写到过期会话上。
    let continuation = topicContinuations.get(key);
    if (!continuation) {
      const continuationGeneration = topicGenerations.get(key) ?? 0;
      const current = async () => (await repo.readState()).bots[key];
// observedSourceCommandId 是 readRunningRun 与 stopAndWait 之间的记忆：execution 的
// sourceCommandId 只在读 run 时可见，停止后要标对应 input 的进度只能靠它带过去。
      let observedSourceCommandId: string | undefined;
      continuation = createTopicContinuation<PreparedTopicMessage>({
// 端口契约：返回当前 run 的 executionId，或 undefined 表示“无需停止，直接提交”。
// 无 activeTaskId 是“话题里还没有任务”的正常状态，不是错误。
        readRunningRun: async () => {
          const context = await current();
          if (!context?.activeTaskId) return undefined;
          const service = await resolveZCodeTaskServiceForContext(context);
// [失败路径] 读不到运行态时抛错，让 continuation 走 failed 并标记材料；
// 返回 undefined 会在“可能正在跑”的情况下直接提交，造成两轮并发。
          if (!service.readBotTopicExecution)
            throw new Error("Topic runtime control is unavailable");
          const execution = await service.readBotTopicExecution({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          });
// 每次调用都覆盖（即使为 undefined），避免沿用上一次的值去标记错误的 input。
          observedSourceCommandId = execution?.sourceCommandId;
          return execution?.executionId;
        },
// [事务] 端口要求“等到 run 的权威终态”而不是只等 stop ACK；adapter 的实现是先注册 ended 监听
// 再发 stop 并 await 监听，因此这里的 await 已包含等待终态，本层无需再轮询。
// waitingStop 先置位再广播：新到达的消息在 prepare 时即继承“正在等停止”，不会先显示“准备中”。
        stopAndWait: async (executionId) => {
          const context = await current();
          if (!context?.activeTaskId) throw new Error("Topic task disappeared during stop");
          topicPreparation.setWaitingStop(key, true);
          await publishTopicPreparation();
// [失败路径] 无论 stop 成功还是抛错都必须清 waitingStop，否则后续消息永远卡在“等待停止”。
// 带代际判断是因为取消后新一代自己管理该标记，旧回调不能替它清掉；stop 的错误继续上抛。
          try {
            await stopTopicRun(context, executionId, observedSourceCommandId);
          } finally {
            if (continuationGeneration === (topicGenerations.get(key) ?? 0)) {
              topicPreparation.setWaitingStop(key, false);
              await publishTopicPreparation();
            }
          }
        },
// submit 收到的是已按“到达顺序”准备好的整批材料（topicContinuation 保证顺序而非完成顺序）。
// 这里只更新投影并调用 handleMessage，admission 幂等键仍由 CLI 侧决定，本文件绝不另建队列。
        submit: async (batch) => {
          topicPreparation.update(
            key,
            batch.map((entry) => entry.message.actor.providerMessageId!),
            "preparing",
          );
          await publishTopicPreparation();
// 合批语义：最后一条作为身份（提交幂等键取它的 providerMessageId），
// 其余成员只贡献附件、表情与文本拼接，不产生独立任务输入。
          const last = batch.at(-1)!;
          const combined = {
            ...last.message,
            text:
              batch.length === 1
                ? last.message.text
                : batch
// 多条时按“发送者: 文本”拼接：模型需要知道每句是谁说的，否则多人同时提需求会被当成一个人改口。
// 单条时原样使用 text，保持与普通消息完全一致的内容口径。
                    .map(
                      ({ message: original }) =>
                        `${original.actor.displayName || original.actor.providerUserId}: ${original.text}`,
                    )
                    .join("\n\n"),
          };
// [并发] 批次内任一条被取消即整批过期：合批是一次原子提交，不能提交“一半属于旧代”的内容。
// 该函数同时传给 handleMessage，让它在长异步（读历史/建任务）之后还能再次确认。
          const isCurrent = () =>
            batch.every((entry) => entry.generation === (topicGenerations.get(key) ?? 0));
// handleMessage 内部会再走一次授权与持久幂等判重，因此这里不重复判断“是否已接收”。
// 提交后重读状态来判定 accepted：handleMessage 的返回值是给用户的回复，不是 admission 结果。
          const outgoing = await handleMessage(combined, batch, isCurrent);
          const context = await current();
// 只看批次身份那条的 accepted：CLI 的合批记录挂在它名下，
// 若改查每个 original id，合批成员永远找不到记录而全部判失败。
          const accepted = Object.values(context?.group?.inputs ?? {}).some(
            (input) =>
              input.admission === "accepted" &&
              input.source.messageId === last.message.actor.providerMessageId,
          );
// [失败路径] 未被接受（被拒/去重/执行失败）时补 failed 表情，避免消息停在 waiting；
// 只在当前代执行，取消后不得把旧消息改红。
          if (isCurrent() && !accepted && context) {
            const bot = findBot(await repo.readConfig(), message.botId);
            if (bot)
              await Promise.all(
                batch.map((entry) =>
                  updateGroupInputReaction(
                    bot,
                    context,
                    entry.message.actor.providerMessageId,
                    "failed",
                  ),
                ),
              );
          }
// 成功则移出准备投影（材料已交给 CLI），失败则保留并附上回复文本作为原因，
// 让 UI 能展示并允许重试；两种结果都必须 publish，否则投影与事实不一致。
          const ids = batch.map((entry) => entry.message.actor.providerMessageId!);
          if (isCurrent()) {
            if (accepted) topicPreparation.remove(key, ids);
            else
              topicPreparation.update(
                key,
                ids,
                "failed",
                outgoing.map((reply) => reply.text).join("\n"),
              );
            await publishTopicPreparation();
          }
// [并发] 只有批次身份那条拿到 outgoing：一次合批只产生一份回复，逐条回复会刷屏且破坏幂等观感。
// resolver 取走后立即删除，防止 failed/重复回调再次 resolve，也让“谁已回复”保持可追踪。
          for (const entry of batch) {
            const messageId = entry.message.actor.providerMessageId!;
            pendingReplies.get(messageId)?.(entry === last ? outgoing : []);
            pendingReplies.delete(messageId);
          }
        },
// [失败路径] failed 是准备/提交异常的唯一出口，必须同时做三件事：更新投影（带错误文本）、
// 改表情、兑现 reply promise；缺任一件都会留下悬挂交互（INV-04）。
// 代际不符直接 return：迟到异常属于被取消的那一轮，不能污染新一代状态。
        failed: async (ids, error) => {
          // 取消后的旧下载/停止异常不得修改新一代消息的状态或表情。
          if (continuationGeneration !== (topicGenerations.get(key) ?? 0)) return;
          topicPreparation.update(
            key,
            ids,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
          await publishTopicPreparation();
// 重新读配置与状态：失败可能发生在配置变更之后（bot 被禁用），用旧对象会发到错误目标；
// bot 缺失时跳过表情，但下面的 promise 仍必须兑现——用户至少要拿到错误文本。
          const context = await current();
          const bot = findBot(await repo.readConfig(), message.botId);
          if (context && bot)
            await Promise.all(
              ids.map((id) => updateGroupInputReaction(bot, context, id, "failed")),
            );
          for (const messageId of ids) {
            pendingReplies.get(messageId)?.(
// BotReplyError 携带 provider 已构造好的用户可见回复（如权限缺失的具体指引），原样回给用户。
// 其他异常用 administratorErrorReply 包一层：群里 @ owner，私聊直接回错误文本，
// 让“需要管理员处理”的问题不被普通用户误当成自己配错。
              error instanceof BotReplyError
                ? error.replies
                : [
                    administratorErrorReply(
                      message.actor,
                      bot,
                      error,
                      createOutbound(
                        message.actor,
                        error instanceof Error ? error.message : String(error),
                      ),
                    ),
                  ],
            );
            pendingReplies.delete(messageId);
          }
        },
      });
// [并发] 登记在 createTopicContinuation 之后，避免别的消息拿到半初始化对象；
// generation 在此重取一次：创建期间可能刚好被 cancel，这个值要随材料一起带到 submit。
      topicContinuations.set(key, continuation);
    }
    const generation = topicGenerations.get(key) ?? 0;
// 准备回调的顺序就是安全边界：先授权 → 再校验代际 → 更新投影 → 准备附件。
// INV-01：授权只由 withAuthorizedContext 依据可信配置与 group metadata 判定，
// 消息正文、@ 文本都无法提权；失败时用 BotReplyError 保留具体拒绝原因。
    const received = continuation.receive(id, async () => {
      const auth = await withAuthorizedContext(message, "message");
      if (!auth.ok) throw new BotReplyError(auth.reply);
// [并发] 授权是异步的，期间可能被 /stop 或群级撤销；代际变化后继续准备会把已取消的消息提交上去。
// 这里抛错会走 failed 路径，而 failed 同样有代际判断，故不会再给用户回消息。
// add 在内容准备之前：让用户在长附件下载期间就看到“准备中”。
      if (generation !== (topicGenerations.get(key) ?? 0)) throw new Error("Topic input cancelled");
      topicPreparation.add(key, message);
      await publishTopicPreparation();
// 用授权返回的 auth.bot/auth.context 而不是外层闭包变量：只有它们代表本次有效上下文。
// prepared 是材料 Promise，失败由 continuation 统一捕获，不在这里吞掉。
      await updateGroupInputReaction(auth.bot, auth.context, id, "waiting");
      return {
        message,
        generation,
        prepared: await prepareBotMessageContent(auth.bot, message, auth.locale),
      };
    });
// receive 返回 false 表示 continuation 内部已见过该 id（重复投递），
// 必须立刻兑现空回复，否则调用方永远 await 不到结果。
    if (!received) {
      pendingReplies.get(id)?.([]);
      pendingReplies.delete(id);
    }
// [资源] settled 只等到“当前 drain 结束”，期间可能又有新消息入队；
// 因此要同时满足 size===0 且仍是同一个 continuation 才清理两张表，否则会删掉新一轮的登记。
    const active = continuation;
    void active.settled().finally(() => {
      if (pendingReplies.size === 0 && topicContinuations.get(key) === active) {
        topicContinuations.delete(key);
        topicReplies.delete(key);
      }
    });
// 调用方 await 到的是本条消息应回的文本；合批时非身份成员为 []，与静默去重的返回语义一致。
    return result;
  }

// handleMessage：单条（或合批）消息的主流程。顺序：授权 → 持久幂等判重 → 话题历史 →
// 请求体校验 → 软删除任务处理 → elicitation 文本 → 附件准备 → 草稿创建 / 续跑 → 提交。
// 原则：会改变状态的副作用尽量排在用户可见校验之后，避免“建了任务再报错”。
// 副作用：网络（历史/附件/模型解析）、创建或恢复 task、写 context、广播、启动 stream watch。
// 返回值是给 IM 的即时回复；任务进度与结果由 stream 投影另行投递。
// 维护 INV-01（授权）、INV-02（context 写入）、INV-04（输入必有终态）、INV-08（模型选择）。
  async function handleMessage(
    message: BotInboundMessage,
    topicBatch?: PreparedTopicMessage[],
    isCurrent = () => true,
  ): Promise<BotOutboundMessage[]> {
// 授权失败直接返回鉴权回复且不再触碰状态：这一步是全流程唯一的可信元数据来源（INV-01）。
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) {
      return auth.reply;
    }
// [并发] INV-03 的读侧：判重必须覆盖 source.messageId（单条）与 source.messages（合批成员），
// 只查前者会让被并入合批的其它消息在重投时找不到记录，从而重复执行。
    const priorInput =
      auth.context.group && message.actor.providerMessageId
        ? Object.values(auth.context.group.inputs ?? {}).find(
            (input) =>
              input.source.messageId === message.actor.providerMessageId ||
              input.source.messages?.some(
                (item) => item.messageId === message.actor.providerMessageId,
              ),
          )
        : undefined;
// [失败路径] 记录属于更早的任务：重投不能在新任务里再跑一遍，否则一次网络重试就重复产生副作用。
// 只回提示不写状态，保持原记录不变。
    if (priorInput && priorInput.taskId !== auth.context.activeTaskId) {
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US"
            ? "This message belongs to an earlier task and will not be executed again."
            : "这条消息已关联到此前任务，不会在新任务中重复执行。",
        ),
      ];
    }
    // CLI 重启后幂等窗口可能已变化；持久化接收记录不能只依赖内存事件去重。
// accepted 表示已进入 CLI 队列，重投应完全静默（返回 []），否则用户会收到“重复”提示而任务其实正常执行。
// 非 accepted（准备失败/被拒）保留记录但未承接，回提示让用户先核对再决定是否重新 @。
    if (priorInput) {
      if (priorInput.admission === "accepted") return [];
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US"
            ? "This message already has an admission record. Check the task before submitting another request."
            : "这条消息已有接收记录，请先在任务中核对执行状态，不会自动重复提交。",
        ),
      ];
    }
// 只有群话题需要补历史；私聊本身就是连续会话，重复拉取只增加延迟与权限要求（INV-06：
// 读取话题资源前先经 provider 的授权读取器）。失败不抛，转为 historyError 由下面统一处理。
    const history = auth.context.group
      ? await prepareGroupTopicHistory(auth.bot, message, auth.context)
      : {};
// 合批去重：历史在提交前读取，可能已包含本批消息本身；不剔除会让模型看到同一句话两遍。
    if (history.topicContext && topicBatch) {
      const ids = new Set(topicBatch.map((entry) => entry.message.actor.providerMessageId));
      history.topicContext.messages = history.topicContext.messages.filter(
        (entry) => !ids.has(entry.id),
      );
    }
// [失败路径] 历史不可用时不提交任务：群话题缺少上文会生成错误上下文，比“稍后重试”代价更高。
// 三种文案分别对应：开关被关、缺少应用身份权限、临时读取失败；权限问题额外给平台链接与权限名
// （im:message.group_msg），否则管理员无从下手。
    if (history.historyDisabled || history.historyError) {
      const en = auth.locale === "en-US";
// 用类型判断而不是错误文本匹配：provider 层已把“缺权限”归一成专属错误类，文案可随语言变化。
      const permissionDenied = history.historyError instanceof TopicHistoryPermissionError;
      const platformUrl =
        auth.bot.provider === "lark"
          ? "https://open.larksuite.com/app"
          : "https://open.feishu.cn/app";
      const text = history.historyDisabled
        ? en
          ? "Topic history is disabled. Ask the bound user to enable /history on before using topics."
          : "话题历史已关闭，暂时无法处理话题消息。请绑定用户发送 /history on 后重新 @。"
        : permissionDenied
          ? en
            ? `Topic history permission is missing. No task was submitted. Ask the app administrator to open ${platformUrl}, select this bot app, enable the required application-identity message permissions (including im:message.group_msg), and publish the change. Then mention the bot again.`
            : `机器人缺少话题历史读取权限，未提交任务。请应用管理员打开 ${platformUrl}，选择当前机器人应用，在权限管理中开通应用身份的消息读取权限（包括 im:message.group_msg，获取群组中所有消息），并发布生效后重新 @。无需安装或授权 lark-cli。`
          : en
            ? "Topic history could not be read. No task was submitted. Please retry by mentioning the bot again later."
            : "暂时无法读取话题历史，未提交任务。请稍后重新 @ 重试。";
      return [
        history.historyDisabled
// 只有“历史被关闭”走 administratorReply（会 @ 群 owner）：那是绑定用户才能改的配置；
// 权限缺失与临时失败只回给发送者，避免反复 @ 管理员制造噪音。
          ? administratorReply(
              message.actor,
              auth.bot,
              "history",
              createOutbound(message.actor, text),
            )
          : createOutbound(message.actor, text),
      ];
    }
// 历史读取成功后才清除“需要管理员”的提醒状态，让提醒与真实故障同生命周期。
    adminAttention.clear(message.actor, auth.bot.providerUserId, "history");
    // commandText 属于单条消息；尾部纯 @ 不能抹掉停止期间批次里其他成员的有效需求。
// 逐条判断“是否携带需求”：只要有成员带正文、附件或引用，整批就算有请求。只看最后一条会把
// “先发文件、再单独 @ 一下”判成空请求。commandText 优先于 text：纯 @ 的 text 含 @ 片段，不算需求。
    const hasRequest = (topicBatch?.map((entry) => entry.message) ?? [message]).some((original) =>
      Boolean(
        (original.commandText ?? original.text).trim() ||
        original.attachments?.length ||
        original.referencedMessage,
      ),
    );
// 既无需求也无引用/历史时拒绝：提交空 prompt 会创建一个永远等输入的任务，
// 而用户其实只是 @ 了一下机器人（INV-04：不制造无终态的输入）。
    if (auth.context.group && !hasRequest) {
      const hasBackground = (history.topicContext?.messages.length ?? 0) > 0;
      if (!message.referencedMessage && !hasBackground) {
        return [
          createOutbound(
            message.actor,
            auth.locale === "en-US"
              ? "Please add a request, or reply to the message you want me to handle and mention me."
              : "请补充需求，或回复要处理的消息并 @我。",
          ),
        ];
      }
      // 仅 @ 的输入已有引用或历史附件；补写指令会把系统文案伪装成用户正文。
      // 保留原文中的 @，由标准引用／附件承载材料，不重新解析材料里的命令。
    }
// 引用正文按“用户可见原文”处理，长度上限复用会话选择文本上限；
// 超限走用户可见错误而不是截断（INV-06 的统一口径：超限必须让人看见）。
    if (message.referencedMessage) {
      // 原先拼接消息 ID 会诱使模型再次查飞书；标准引用只携带真实原文，并复用 UI 展示。
      const quote = message.referencedMessage.text;
      if (quote.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH) {
        return [
          createOutbound(
            message.actor,
            auth.locale === "en-US"
              ? "The quoted text is too long. Please quote a shorter passage or attach it as a file."
              : "引用文字过长，请缩小引用范围或作为文件提交。",
          ),
        ];
      }
    }
// 软删除任务检测：桌面删除只留 tombstone，CLI 仍能恢复旧 session，
// 但 Bot 不能仅凭 activeTaskId 往一个用户已删除的任务里继续写内容。
    let deletedTaskId: string | undefined;
    if (auth.context.mode === "task" && auth.context.activeTaskId) {
      const taskService = await resolveZCodeTaskServiceForContext(auth.context);
// 必须带 workspaceIdentity：别的 Host 上的同名任务可能有效，只按路径查会误判删除。
      const deletedTaskIds = await taskService.listDeletedTaskIds({
        workspacePath: auth.context.workspacePath,
        workspaceIdentity: auth.context.workspaceIdentity,
      });
      if (deletedTaskIds.includes(auth.context.activeTaskId)) {
        // 桌面软删除只留下 tombstone，CLI 仍可恢复旧 session。
        // Bot 不能只凭 activeTaskId 续跑隐藏任务；先清旧交互，再复用当前草稿有效选择和 V4 首发。
        // 仅以删除记录为准，不能把列表过滤、归档或查询失败当成删除。
// [事务] 先 writeDraftContext（清 activeTaskId 与所有 pending 交互）再建新任务；
// 反过来会先建新任务、再被草稿写入覆盖回旧值，状态与 CLI 事实不一致。
        deletedTaskId = auth.context.activeTaskId;
        auth.context = await writeDraftContext(auth.context);
      }
    }
// 私聊里“上一条 elicitation 的文本回答”必须先被消费；群聊交互走卡片回调，不在这里解析。
    const elicitationReply = auth.context.group
      ? null
      : await handlePendingElicitationText(auth, message.actor, message.text);
// 已消费为交互回答就不再当新输入执行，否则用户回答“1”会被当成新任务 prompt（INV-11）。
    if (elicitationReply) {
      return elicitationReply;
    }
    if (
      !auth.context.group &&
      auth.context.mode === "task" &&
      auth.context.activeTaskId &&
// 私聊续跑前用与 /task 完全相同的判定确认空闲：两处口径若分叉，会出现“菜单说不能切、输入却照提交”。
// 群聊不在这里判断，交给 submitGroupMessage 的 CLI 队列语义。
      (await getContextTaskBlockReason(auth.context))
    ) {
      return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
    }
// 附件下载与内容准备集中在一个 try：任何失败都统一转成 attachmentRejected，用户能知道哪个附件被拒；
// 这里不写状态、不建任务，失败是纯读取侧后果。
    let preparedMessage: PreparedBotMessageContent;
    try {
      preparedMessage = topicBatch
        ? {
            content: message.text,
            zcodeAttachments: topicBatch.flatMap((entry) => entry.prepared.zcodeAttachments),
          }
        : await prepareBotMessageContent(auth.bot, message, auth.locale);
// 历史作为文本附件追加而不拼进 prompt 正文：保留消息结构，UI 也能按附件展示；
// commandId 由 bot+chat+messageId 组成，保证同一消息的附件标识稳定、可幂等去重。
      const historyMaterial = history.topicContext;
      if (auth.context.group && historyMaterial) {
        const attachment = createTopicHistoryAttachment(
          historyMaterial,
          botGroupCommandId(
            auth.bot.id,
            auth.context.group.chatId,
            message.actor.providerMessageId!,
          ),
          auth.context.group.topicTitle || auth.context.group.name,
        );
        if (attachment) preparedMessage.zcodeAttachments.push(attachment);
      }
    } catch (error) {
      return [
        createOutbound(
          message.actor,
          msg(auth.locale, "attachmentRejected", {
            message: formatAttachmentRejectedReason(error, auth.locale),
          }),
        ),
      ];
    }
// [并发] 附件准备是长异步，期间可能被取消；代际不一致就放弃后续所有副作用
// （不建任务、不写 context、不广播），否则会留下“用户已撤销却仍在执行”的任务。
    if (!isCurrent()) return [];
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
// 复用已有 draftOptions（用户前面用 /model 等命令选过），只有缺失时才初始化；
// 每次重建会把用户显式选择覆盖成默认值（INV-08）。
      const draftOptions =
        auth.context.draftOptions ?? (await buildInitializedDraftOptions(auth.context));
      // 原因：直接提交旧账号身份会绕过统一解析。只在首次创建前解析原意图；
      // 后续创建、配置和首发固定这份结果；绑定后以 Session 原选择解析下一次新输入。
// 只在首次创建前解析一次：有显式选择时必须解析出 effectiveSelection；没有显式选择才接受
// preferredSelection（默认候选）。解析只服务本次提交，不回写 Session。
      const selectionView = await readModelSelectionView(auth.context, draftOptions.modelSelection);
      const submissionModelSelection = draftOptions.modelSelection
        ? selectionView?.effectiveSelection
        : selectionView?.preferredSelection;
      if (
        !submissionModelSelection ||
        (draftOptions.modelSelection && selectionView?.selectionIssue)
      ) {
// INV-08：显式选择无法解析时抛 BotAdminRequiredError，而不是静默回退默认模型；
// 上层会把它转成“请管理员检查模型配置”的指引。throw 在 createTask 之前，不留半成品任务。
        throw new BotAdminRequiredError("model", "Bot 无法从目标 Host 解析 Submission 模型");
      }
// 固化本次解析结果并深拷贝 options：后续 createTask、applyDraftConfigOptions 与首发共用同一份，
// 避免各步各自读取配置导致“首条消息用的模型与列表显示的不一致”。
      const submissionDraftOptions: BotDraftOptions = {
        ...draftOptions,
        modelSelection: {
          providerId: submissionModelSelection.providerId,
          modelId: submissionModelSelection.modelId,
          ...(submissionModelSelection.options
            ? { options: { ...submissionModelSelection.options } }
            : {}),
        },
      };
      const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
// 副作用起点：这之后任何失败都需要显式清理（见下面的 deleteTask）。
// 用 context 的 workspace/identity 而不是 actor：workspace 属于会话上下文，不由消息决定。
      const task = await zcodeTaskService.createTask({
        workspacePath: auth.context.workspacePath,
        workspaceIdentity: auth.context.workspaceIdentity,
        projectId: auth.context.projectId ?? null,
        additionalDirectories: auth.context.additionalDirectories ?? [],
        provider: draftOptions.provider,
        modelSelection: submissionDraftOptions.modelSelection,
        // 修复原因：Bot 旧 createTask 走 legacy session/create，却紧接着用 v4 sendText，
        // 内存标志与 v4 draft 持久化边界不一致，session_input 会触发 FK。改为先创建
        // v4 draft，再沿既有能力校验应用配置，最后通过 v4 sendText 首发。
// 群任务强制 permissionScope=session：授权来源是 BotGroupSource，群任务不能继承用户级更宽的权限
// （INV-01）。私聊不传，沿用绑定用户的既有 scope。
        v4Create: true,
        ...(auth.context.group ? { permissionScope: "session" as const } : {}),
      });
// 群任务标题拼“平台 · 群名 · 话题名”：同一群可并行多个话题任务，侧栏必须能区分；
// 私聊没有群名可拼，改用首条内容经 deriveTaskTitle 派生标题。
      const taskTitle = auth.context.group
        ? [
            auth.bot.provider === "lark" ? "Lark" : "飞书",
            auth.context.group.name,
            ...(auth.context.group.threadId
              ? [auth.context.group.topicTitle || auth.context.group.threadId]
              : []),
          ].join(" · ")
        : deriveTaskTitle(preparedMessage.content, preparedMessage.zcodeAttachments);
// createTask 返回的标题为空；广播前补上派生标题，否则侧栏会一直显示“新任务”直到整表刷新。
      const broadcastTask = taskTitle ? { ...task, title: taskTitle } : task;
      const traceId = generateTraceId(task.taskId);
// [事务] 配置必须发生在写 Bot 任务状态之前：配置失败就删掉刚建的任务，
// 用户修正配置后可直接重试，不会留下“上下文已切到空任务、任务却不可用”的死状态。
      try {
        await applyDraftConfigOptions(
          { ...auth.context, draftOptions: submissionDraftOptions },
          task.taskId,
          traceId,
        );
      } catch (error) {
        // Bugfix: 初始配置失败时旧流程已把 context 切到 task，留下无法继续的空任务。
        // 在持久化 Bot task 状态前完成配置，并删除临时 task，让用户修正配置后可以直接重试。
        await zcodeTaskService
          .deleteTask({
            taskId: task.taskId,
            workspacePath: auth.context.workspacePath,
            workspaceIdentity: auth.context.workspaceIdentity,
          })
// [失败路径] 清理失败只吞掉：原始配置错误更重要，不能被清理错误覆盖；
// 残留任务成为孤儿（可被 listDeletedTaskIds 或用户手动清理），这是有意的取舍。
          .catch(() => undefined);
        throw error;
      }
// 这是本次接受的提交点：配置已成功、任务已存在，才把上下文切到 task。
// [事务] writeContext 经 serializeStateWrite 串行落 repo（INV-02），内存 Map 只是投影；
// 这一步失败会抛错，任务成为未被任何上下文引用的孤儿（风险点，只标注）。
// draftOptions 置空：进入 task 模式后，模型选择的事实来源是任务本身。
      const context = {
        ...auth.context,
        mode: "task" as const,
        activeTaskId: task.taskId,
        draftOptions: undefined,
      };
      await writeContext(context);
      // Bugfix: Bot 首发不经过 UI 本地 deriveTaskTitle/optimistic cache。
      // 如果 created 广播继续携带 createTask 的空标题，侧栏会一直显示 New task，直到整表刷新。
// created 广播必须带补好的标题与完整 task：Bot 首发不经过 UI 的本地乐观缓存，
// 这里漏字段就只能等整表刷新才恢复。
      await broadcastTaskListChange(context, task.taskId, "created", {
        task: broadcastTask,
      });
      if (deletedTaskId) {
        botsLogger.info(
          undefined,
          `replaced deleted Bot task bot=${auth.bot.id} oldTask=${deletedTaskId} newTask=${task.taskId} workspace=${getWorkspaceKey(context.workspacePath, context.workspaceIdentity)}`,
        );
// 通知只是给用户看的说明，不属于状态事实；失败只 warn——抛出去会让上层 callback 判定整条消息失败，
// 从而释放去重记录并重跑原消息。
        // 切换已经持久化；通知失败不能让 callback 释放去重记录并重跑原消息。
        await sendOutbound(
          auth.bot,
          createOutbound(message.actor, msg(auth.locale, "deletedTaskReplaced")),
        ).catch((error: unknown) => {
          botsLogger.warn(
            undefined,
            `deleted task replacement notice failed bot=${auth.bot.id} task=${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
// 群输入统一走 submitGroupMessage：它调用 CLI 的 group input admission，
// 本文件不维护第二份 accepted queue（否则两份权威队列并存，违背 INV-04/INV-07）。
      if (context.group)
        return submitGroupMessage(
          auth.bot,
          message,
          context,
          preparedMessage,
          auth.locale,
          history,
          topicBatch,
          isCurrent,
        );
// [并发] 先登记 running 再启动 watch：stream 可能立刻推事件，若 running 还没加，
// getContextTaskBlockReason 会误判空闲并允许并发切换。
// 第四个参数用 auth.user（绑定用户配置）而不是 bot：回复模式属于用户偏好，不是 bot 默认值。
      runningTasks.add(task.taskId);
      await watchTaskStream(auth.bot, message.actor, context, auth.user);
// prompt_sent 携带正文与附件，让侧栏立即出现用户消息，不必等 agent 回显；
// messageId 前缀 bot- 用于把 Bot 输入与真实 IM 消息 id 区分开。
      await broadcastTaskListChange(context, task.taskId, "prompt_sent", {
        task: broadcastTask,
        prompt: {
          content: preparedMessage.content,
          attachments:
            preparedMessage.zcodeAttachments.length > 0
              ? preparedMessage.zcodeAttachments
              : undefined,
          messageId: `bot-${traceId}`,
          sentAt: Date.now(),
        },
      });
// [权衡] 刻意不 await：handleMessage 的返回值是给 IM 的即时回复，等待整轮会阻塞 Telegram 的
// update 循环（见 sendPromptInBackground 头部）。botDeliveryTarget 只对支持回推的渠道生成。
      sendPromptInBackground(
        auth.bot,
        message.actor,
        context,
        task.taskId,
        traceId,
        preparedMessage.content,
        preparedMessage.zcodeAttachments,
        resolveAutomationBotDeliveryTarget(message.actor),
        submissionDraftOptions.modelSelection,
      );
// 私聊新建任务不回任何文本：进度与结果由 stream 投影投递，额外回执只会刷屏。
      return [];
    }
// 群续跑也交给 submitGroupMessage：是否排队/拒绝由 CLI 队列语义决定，
// 本文件不预判“任务是否在跑”，避免与 CLI 的 admission 结论打架。
    if (auth.context.group)
      return submitGroupMessage(
        auth.bot,
        message,
        auth.context,
        preparedMessage,
        auth.locale,
        history,
        topicBatch,
        isCurrent,
      );
// 续跑前显式 resume：CLI 可能已 idle 或刚重启，不 resume 直接 sendPrompt 会没有可用 run。
// resume 失败会抛出，用户收到错误提示，而不是“看起来提交了却什么都没发生”。
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
    await zcodeTaskService.resumeTask({
      taskId: auth.context.activeTaskId,
      workspacePath: auth.context.workspacePath,
      workspaceIdentity: auth.context.workspaceIdentity,
    });
    // Bot 只是同一 Session 的输入端。菜单可能过滤无效值，不能拿它反推原选择，
    // 更不能重新套用 Bot 创建默认值。解析只确定本次输入，不在此改写 Session。
// 从任务本身读原选择，而不是从菜单缓存读：菜单值可能被过滤/本地化，且不含完整 options。
// 解析结果只决定本次输入，不改写 Session（INV-08）。
    const originalSelection = await zcodeTaskService.getTaskModelSelection({
      taskId: auth.context.activeTaskId,
    });
    const selectionView = originalSelection
      ? await readModelSelectionView(auth.context, originalSelection)
      : null;
// 无法解析则拒绝本次输入：不能用默认模型顶替会话级选择（INV-08 不得静默改写），
// 错误文本经本地化，用户可据此去 /model 修正。
    const effectiveSelection = selectionView?.effectiveSelection;
    if (!effectiveSelection || selectionView?.selectionIssue) {
      throw new Error(msg(auth.locale, "sessionModelUnavailable"));
    }
// 先广播 resumed 再 prompt_sent：UI 需先确认运行态恢复，否则输入会挂在不存在的 running 上。
    await broadcastTaskListChange(auth.context, auth.context.activeTaskId, "resumed");
    runningTasks.add(auth.context.activeTaskId);
    await watchTaskStream(auth.bot, message.actor, auth.context, auth.user);
    const traceId = generateTraceId(auth.context.activeTaskId);
    await broadcastTaskListChange(auth.context, auth.context.activeTaskId, "prompt_sent", {
      prompt: {
        content: preparedMessage.content,
        attachments:
          preparedMessage.zcodeAttachments.length > 0
            ? preparedMessage.zcodeAttachments
            : undefined,
        messageId: `bot-${traceId}`,
        sentAt: Date.now(),
      },
    });
// 显式传入本次解析出的 effectiveSelection：发送侧不再读一次配置，
// 避免“解析时一个模型、发送时另一个模型”的读写竞态。
    sendPromptInBackground(
      auth.bot,
      message.actor,
      auth.context,
      auth.context.activeTaskId,
      traceId,
      preparedMessage.content,
      preparedMessage.zcodeAttachments,
      resolveAutomationBotDeliveryTarget(message.actor),
      effectiveSelection,
    );
    return [];
  }

// handleTaskList：/task 列表。最多 10 条、运行中直接拒绝、并把带 workspaceIdentity 的 entry
// 缓存起来供后续序号解析。选项 id 用 taskId（稳定协议值），不是序号或标题。
  async function handleTaskList(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "task");
    if (!auth.ok) {
      return auth.reply;
    }
// 话题内不列任务：话题是独立会话，列全量任务既无法序号选择，也会把别的会话任务串进来。
    if (message.actor.threadId) return createStatusReply(message.actor, auth.context, auth.locale);
// 与私聊输入共用同一阻断判定，保证“能不能提交”和“能不能切换”永远同口径。
    const blockReason = await getContextTaskBlockReason(auth.context);
    if (blockReason) {
      // Bugfix: 运行中展示 /task 列表会让用户继续点选其它 task，
      // 即使后续切换被拒绝，也会留下误导性的 pending selection。
      return [createOutbound(message.actor, msg(auth.locale, blockReason))];
    }
// 上限 10 不是性能限制而是交互限制：纯文本渠道只能用一位数字选择，
// 更长的列表既无法回复也超出卡片可读性。
    const taskEntries = (await listContextTaskSelectionEntries(auth.context, auth.user)).slice(
      0,
      10,
    );
    const tasks = taskEntries.map((entry) => entry.task);
// 只在本次可见列表里找 active：任务可能已被删除或不在当前项目过滤范围内，
// 此时标题显示 draft，避免出现菜单里选不到的任务。
    const activeTask = auth.context.activeTaskId
      ? tasks.find((task) => task.taskId === auth.context.activeTaskId)
      : null;
// [权衡] selection.id 用时间戳：它只用于本地关联一次渲染，不参与回调寻址；
// 但选项 id 必须用 taskId，因为“渲染 → 点击 → 回调”之间要保持稳定（INV-11 同口径）。
    const selection: SelectionPrompt = {
      id: `task-${Date.now()}`,
      title: msg(auth.locale, "taskSelectTitle", {
        task: activeTask ? `${activeTask.title} (${activeTask.taskId})` : "draft",
      }),
      currentId: auth.context.activeTaskId ?? undefined,
      action: "task.set",
      options: taskEntries.map((entry) => ({
        id: entry.task.taskId,
        label: entry.task.title,
        description: taskStatus(entry.task),
      })),
    };
// [资源] 缓存 entry 而非只缓存 taskId：远端二次查询必须带 workspaceIdentity，
// 否则会退回 path-only 语义并报 Task not found。
    if (taskEntries.length > 0) {
      // Bugfix: 远端 task 展示时必须把 workspaceIdentity 一起缓存。
      // 否则点击 /task 的序号后只剩 taskId，后续二次查询会退回 path-only 语义并提示 Task not found。
      pendingTaskSelectionsByContext.set(
        getActorContextKey(message.actor),
        new Map(taskEntries.map((entry) => [entry.task.taskId, entry])),
      );
// 空列表要清掉旧缓存：否则用户点上一轮残留的序号，仍能解析到一个已不可见任务。
    } else {
      pendingTaskSelectionsByContext.delete(getActorContextKey(message.actor));
    }
// 空列表回纯文本而不是空 selection：空菜单会让用户面对一张没有任何可选项的卡片。
    return tasks.length > 0
      ? createSelectionReply(message.actor, selection, auth.locale)
      : [createOutbound(message.actor, msg(auth.locale, "noHistoryTasks"))];
  }

// resolveTaskSelectionEntry：把用户回的数字/标题/taskId 解析成任务 entry。
// 快照只用于“认出用户指的是哪个 id”，最终 entry 必须来自重新列出的权威列表，
// 因此快照不能绕过项目、工作区与固定 cwd 的边界（与 INV-01 同思路：只信权威来源）。
  async function resolveTaskSelectionEntry(
    message: BotInboundMessage,
    context: BotContextState,
    user: BotConfig,
    value: string,
  ): Promise<BotTaskSelectionEntry | null> {
// pending 提供带 workspaceIdentity 的 taskId，再由 resolveOptionByValue 在权威列表里按 id 或 label
// 匹配；匹配不到返回 null，由调用方回“选择已失效”，不猜。
    const entries = await listContextTaskSelectionEntries(context, user);
    // 旧菜单只解析 taskId，实际归属必须重读；snapshot 不得绕过项目与固定 cwd 边界。
    const pending = resolvePendingTaskSelectionEntry(message.actor, value);
    return (
      resolveOptionByValue(
        entries.map((entry) => ({ id: entry.task.taskId, label: entry.task.title, entry })),
        pending?.task.taskId ?? value,
      )?.entry ?? null
    );
  }

// getContextTaskBlockReason：判断当前上下文能否切换/提交。null=空闲，字符串=给用户看的原因。
// 群与私聊的证据不同：群以 CLI 队列为权威，私聊以 runningTasks + 终态快照双证据——
// 因为群输入可能由别的进程/上一轮仍在排队，本进程的内存标记并不可信。
  async function getContextTaskBlockReason(
    context: BotContextState,
  ): Promise<
    "taskRunning" | "groupTaskQueued" | "groupTaskInteraction" | "groupTaskDisconnected" | null
  > {
// INV-05：远端未连接时连查询都不发起，直接返回 disconnected 让用户显式 /reconnect；
// 若在这里死等或隐式建连，会把一个本地命令变成远端连接尝试。
    if (!context.activeTaskId) {
      return null;
    }
    if (context.group) {
      if (context.workspaceIdentity && !(await isRemoteWorkspaceConnected(context)))
        return "groupTaskDisconnected";
      const taskService = await resolveZCodeTaskServiceForContext(context);
// [失败路径] 无法确认队列状态时抛错（保守）：假装空闲会让两条输入并发提交给 CLI。
      if (!taskService.getBotGroupTaskBlockReason)
        throw new Error("Runtime cannot verify group queue state");
// 权威来源是 CLI 的队列/交互状态；本文件的 group inputs 只是投递投影，不能用来判断“是否在跑”。
      const reason = await taskService.getBotGroupTaskBlockReason({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      });
// debug 级：每次 /task 或输入都会调用，属高频诊断，进 info 会让生产日志随流量膨胀。
      botsLogger.debug(
        undefined,
        `group task switch check task=${context.activeTaskId} reason=${reason ?? "idle"}`,
      );
// 未知 reason 归入 taskRunning：宁可保守阻断并提示“任务运行中”，也不放行不确定状态。
      if (reason)
        return reason === "queued"
          ? "groupTaskQueued"
          : reason === "interaction"
            ? "groupTaskInteraction"
            : "taskRunning";
      // 停止或在 Desktop 处理审批后，Bot 卡片缓存可能仍残留；不能让缓存否决 CLI 空闲状态。
// [资源] 顺序不可换：先 clearPendingElicitationSelection 释放选择 token/草稿，再置空字段，最后写盘；
// 反过来会留下一个没人能再解析的 token（INV-11 悬挂交互）。
      if (context.pendingElicitation || context.pendingPermissionOptions?.length) {
        if (context.pendingElicitation)
          clearPendingElicitationSelection(context.pendingElicitation);
        context.pendingElicitation = undefined;
        context.pendingPermissionOptions = undefined;
// false=不改授权；最后参数是期望的 activeTaskId：并发切换后若已不是同一任务，
// writeContext 会放弃写入，避免把清理落到新任务上。
        await writeContext(context, false, context.activeTaskId);
        botsLogger.info(
          undefined,
          `cleared stale group interaction cache task=${context.activeTaskId}`,
        );
      }
      return null;
    }
// 私聊快速路径：本进程没发起过这个任务就直接空闲，避免每次 /task 都打 runtime 快照。
// 远端断连时把内存 running 视为“不可确认”并放行本地操作（如 /workspace），
// 由用户显式 /reconnect 后恢复真实查询（INV-05 的另一面：不为查状态而建连）。
    if (!runningTasks.has(context.activeTaskId)) {
      return null;
    }
    if (context.workspaceIdentity && !(await isRemoteWorkspaceConnected(context))) {
      // Bugfix: /workspace 这类本地命令只是在切换上下文，不能为了确认旧任务状态而创建远端 runtime。
      // 断连时把内存 running 状态视为不可确认，交给显式 /reconnect 后再恢复查询。
      return null;
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
// [失败路径] 快照失败按 null 处理，随后仍返回 taskRunning：无法确认时保守阻断，
// 而不是把查询失败当成“任务已结束”。
    const activeTaskSnapshot = await zcodeTaskService
      .getTaskSnapshot({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      })
      .catch(() => null);
// 只有明确终态才回收内存状态：启动时 runningTasks 可能因重启或丢失流式终态而与磁盘不一致，
// status 为空可能只是旧数据，不能当作“已结束”而放行并发输入。
    if (
      activeTaskSnapshot?.meta.status === "completed" ||
      activeTaskSnapshot?.meta.status === "error"
    ) {
      // Bugfix: Bots 进程内 runningTasks 可能因重启/流式终态事件丢失而和持久化状态不一致。
      // ZCode Agent 历史任务的 status 为空也可能只是旧数据，不代表 UI 仍在运行；只有本进程确实发起
      // 且尚未观察到终态的 task 才阻止 /task、/new 等上下文切换。
// [资源] 终态时顺手停 Typing：这条路径是“发现任务其实已结束”的唯一机会，
// 不停会让表情一直转下去，直到下一轮覆盖。
      runningTasks.delete(context.activeTaskId);
      stopTyping(context.activeTaskId);
      return null;
    }
// 其余情况保守阻断：宁可让用户多等一秒，也不要并发提交两条输入让 CLI 产生两个 run。
    return "taskRunning";
  }

// warnAutomationDeliveryOnce：自动化回推被跳过时的告警节流器。
// 自动化可按分钟级触发，同一配置问题（bot 被删、被禁用、provider 改绑）会反复发生，
// 不节流会瞬间淹没日志；同一 key 在 TTL 内只 warn 一次。
  function warnAutomationDeliveryOnce(params: {
    target: ZCodeAutomationBotDeliveryTarget;
    reason: string;
  }): void {
// key 不含 chatId/threadId：这些都是配置级故障，换一个会话不会有新信息。
    const key = `${params.target.provider}:${params.target.botId}:${params.reason}`;
    const now = Date.now();
// [资源] 只存在内存，进程重启即重置；条目上限是“bot 数 × 原因数”，不随消息增长。
// 用“上次告警时间”而不是滑动窗口计数：自动化触发本身稀疏，计数窗口容易漏报真实故障。
    const previousAt = automationDeliveryWarningAtByKey.get(key) ?? 0;
    if (now - previousAt < BOT_AUTOMATION_DELIVERY_WARNING_TTL_MS) return;
// 先写时间戳再打日志：即使日志实现抛错（被上层吞掉），同一 TTL 内也不会重复刷屏。
    automationDeliveryWarningAtByKey.set(key, now);
    botsLogger.warn(
      undefined,
      `automation Bot delivery skipped provider=${params.target.provider} bot=${params.target.botId} reason=${params.reason}`,
    );
  }

// watchAutomationRun：自动化任务的终态回推入口（调度侧发起 run 后调用）。
// 它不执行任务、不写 Bot 上下文，只负责把 target 校验成“仍然有效的投递目标”后订阅流。
// 任一校验失败都只 warn 一次并返回：自动化配置可能比 bot 配置陈旧，
// 继续用 target 里的 id 发消息会投到错误的人/群（INV-01：授权只信当前持久元数据）。
  async function watchAutomationRun(params: BotAutomationRunWatchParams): Promise<void> {
    const config = await repo.readConfig();
    const bot = findBot(config, params.target.botId);
// bot 已删除：没有可用凭据与身份，任何投递都不可能成功，直接放弃。
    if (!bot) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "bot_missing" });
      return;
    }
// 用户禁用 bot 后自动化不得继续推送：禁用是显式意图，不能被后台任务绕过。
    if (!bot.enabled) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "bot_disabled" });
      return;
    }
// botId 可能在改绑后指向另一个平台账号；不校验会把飞书任务的内容发到微信/Telegram。
    if (bot.provider !== params.target.provider) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "provider_mismatch" });
      return;
    }
// 私聊投递依赖常驻订阅：reconcile 内部按 botId 串行且幂等，不先确保订阅，
// watch 收到事件也发不出去。
    if (params.target.chatType === "private") await reconcilePrivateSynchronization(bot.id);
    let conversationThreadId: string | null | undefined;
    if (params.target.chatType === "group") {
// 群状态键必须是 bot+chat+thread：target.threadId 决定这是不是话题会话，
// 用群默认键会取到另一个会话（默认任务）的授权状态。
      const states = (await repo.readState()).bots;
      const state =
        states[
          getBotConversationKey({
            botId: bot.id,
            chatType: "group",
            chatId: params.target.providerUserId,
            threadId: params.target.threadId,
          })
        ];
// INV-01：只信 BotGroupSource 的 owner 与 enabled，自动化配置本身不构成授权；
// 群被停用或 owner 已改绑时，target 里的群必须视为无效。
      if (!state?.group?.enabled || state.group.ownerId !== bot.providerUserId) {
        warnAutomationDeliveryOnce({ target: params.target, reason: "group_not_authorized" });
        return;
      }
      // 旧 alias 不能继续回退到默认任务；话题投递必须存在独立的授权会话。
// 取授权会话自身的 threadId（null 表示默认群会话），不回退到 target 或当前用户上下文；
// 否则投递会落到一个没有独立授权记录的会话里。
      conversationThreadId = state.group.threadId ?? null;
    }
// 由 target + 已校验的授权状态重建 actor：自动化回推必须落在发起配置的会话，
// 不能复用用户“此刻正在聊”的 actor。群聊把 chatId 设为 providerUserId（配置里存的就是群 id）；
// 私聊不设，让 getBotConversationKey 走 botId 分支。
    const actor: BotActor = {
      provider: params.target.provider,
      botId: params.target.botId,
      providerUserId: params.target.providerUserId,
      chatType: params.target.chatType,
      threadId: params.target.threadId,
      conversationThreadId,
      rootMessageId: params.target.rootMessageId,
      ...(params.target.chatType === "group" ? { chatId: params.target.providerUserId } : {}),
    };
// 这是只读投影上下文：只带路由所需字段，不写回 repo；不带 group/pendingElicitation 等交互字段，
// 避免自动化回推覆盖用户当前会话的交互状态。
    const context: BotContextState = {
      botId: bot.id,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      mode: "task",
      activeTaskId: params.taskId,
      updatedAt: Date.now(),
    };
    // Automation 回推固定为终态摘要；不能复用用户当前 replyMode，否则 streaming/card
    // 会在后台任务执行过程中向原会话持续发送中间过程。
// [权衡] 强制 replyMode=summary_changes：不能沿用用户偏好，否则 streaming/card 会把后台自动化
// 任务的中间过程持续推到会话里，用户会收到大量与当前对话无关的噪音（INV-09 的降噪面）。
// 第 5 个参数是 automation 标识：传 runId 时只接收该 run 的事件，避免排队期间串轮；
// 没有 runId 时传 true，仍按自动化模式订阅并走摘要投递。
    await watchTaskStream(
      bot,
      actor,
      context,
      {
        ...bot,
        replyMode: "summary_changes",
      },
      params.runId ?? true,
    );
  }

  service = {
    async syncAppRuntimePreferences(preferences) {
      // 把本机 UI 偏好同步给远端 runtime；本层不做本地缓存，远端才是偏好事实。
      // [失败路径] remoteWorkspaceService 是可选依赖：本地 workspace 没有远端 runtime，
      // 短路返回不是错误；而远端同步失败必须原样上抛，否则界面显示“已同步”
      // 而远端仍按旧偏好执行，用户无法判断哪一侧才是生效值。
      await deps.remoteWorkspaceService?.syncAppRuntimePreferences?.(preferences);
    },
    // 从这里起是本段的主体：对外公开方法面（config / bot / bind / topic / result / state）。
    // 它不持有会话正文事实（正文归 CLI 的 CommandInbox + ProductProjection），只维护
    // 外部协作状态；因此所有状态写入都必须经 repo + serializeStateWrite，不能另建队列。
    // 约定：抛 Error 表示“当前状态已不允许该操作”，调用方不得盲目重试；
    // 返回 undefined / 空结果才表示幂等吸收（no-op）。
    // 状态面板的唯一数据源：config 来磁盘配置快照，state 是持久协作状态，
    // runtimeByBotId 只是本进程的内存投影（连接态、投递错误等）。
    // 三份数据口径不同，因此 botsCount / enabledBotsCount / contextsCount 三个数
    // 不能互相校验：一个 bot 可能同时拥有私聊、群、多个话题多条 context。
    // [权衡] 这里刻意不占用 serializeStateWrite：只读不写，排队只会拖慢 UI；
    // 代价是单次响应内 config 与 state 可能来自不同代快照，UI 必须容许这种偏差。
    async getStatus() {
      const config = await repo.readConfig();
      const state = await repo.readState();
      return {
        botsCount: config.bots.length,
        enabledBotsCount: config.bots.filter((bot) => bot.enabled).length,
        contextsCount: Object.keys(state.bots).length,
        botRuntime: config.bots.map((bot) => {
          const runtime = runtimeByBotId.get(bot.id);
          return (
            // runtime 缺失说明该 bot 还没启动过（刚重启或从未启用）：按 enabled 推导兜底状态，
            // 避免列表出现空行；offset 回落到持久状态，让重启后的 Telegram 游标仍然可见。
            // 兜底 message 只描述配置结果，不冒充“连接成功”，真实连接态只能来自 runtime。
            runtime ?? {
              botId: bot.id,
              provider: bot.provider,
              status: bot.enabled ? "idle" : "disabled",
              message: bot.enabled ? "Bot is configured." : "Bot is disabled.",
              offset: state.bots[bot.id]?.telegramOffset,
            }
          );
        }),
      };
    },
    // 每次调用都重新读盘并按 schema 解析，返回的是新对象：调用方修改它既不会污染
    // 内存权威状态，也不会被持久化（INV-10 磁盘优先）；要落盘必须走 saveConfig / saveBot。
    // 返回值里可能含 credentialRef（只是引用名，不含密钥本体），UI 不应把它当凭据展示。
    getConfig: () => repo.readConfig(),
    // workspace 列表与用户配置项属于外部能力，直接复用已实现查询：
    // 前者从 project catalog 生成 ref（含远端 host），后者当前是预留实现、恒返回空数组。
    // UI 不得因空数组断言“没有可用模型”，模型候选应走任务级 config options（INV-08）。
    listWorkspaceRefs,
    getUserConfigOptions: listUserConfigOptions,
    // 飞书/Lark 扫码建应用：begin 拿二维码，poll 用 deviceCode 换凭据。
    // 整个流程是有状态的外部 device flow，本层只做透传，不缓存 deviceCode、不重试，
    // 失败原样抛给 UI，由用户重新扫码，避免在服务里留下无人回收的半成品会话。
    beginFeishuRegistration(params) {
      return beginFeishuAppRegistration(params?.domain);
    },
    // poll 的 domain 与 pollDomain 由上游按 tenant_brand 决定，本层不改写：
    // 把 Lark 租户的轮询错误地指向飞书账号服务，会让扫码成功的应用永远拿不到凭据。
    pollFeishuRegistration(params) {
      return pollFeishuAppRegistration(params);
    },
    // 企业微信扫码绑定是另一条独立链路（iLink），与飞书不共享 deviceCode 与域名。
    beginWeixinRegistration() {
      return beginWeixinQrRegistration();
    },
    pollWeixinRegistration(params) {
      return pollWeixinQrRegistration(params);
    },
    // 整份配置覆盖写：先 normalizeConfigBots 把每个 bot 的权限、选项、回复粒度
    // 收敛到当前 schema（旧字段只读不写），再交给 writeBotConfig 做一次原子落盘（INV-10）。
    // [并发] writeBotConfig 会把“因换绑/停用而失效的群授权”接到 stateWriteTail 上串行执行，
    // 但并发的 saveConfig / saveBot 仍各自基于自己读到的旧 config 计算，语义是最后写入者胜；
    // 因此设置页必须串行提交，不能同时保存两份不同配置。
    async saveConfig(config) {
      const savedConfig = await writeBotConfig(normalizeConfigBots(config));
      // 落盘成功后才刷新三个 provider runtime：凭据与启用态必须以已保存配置为准。
      // 提前刷新会让运行时短暂使用未持久化的值，进程崩溃后行为与磁盘不一致。
      telegramRuntime.scheduleRefresh(savedConfig);
      weixinRuntime.scheduleRefresh(savedConfig);
      feishuRuntime.scheduleRefresh(savedConfig);
      return savedConfig;
    },
    // 直接返回配置数组（schema 解析后的新对象）；调用方要编辑必须先深拷贝再改动。
    async listBots() {
      return (await repo.readConfig()).bots;
    },
    // 单 bot 保存，同时是唯一的凭据写入面，步骤顺序不可随意调换：
    // STEP-1 读当前配置作为校验基线；STEP-2 归一化入参；STEP-3 先写 secret 存储；
    // STEP-4 回填 credentialRef / webhookSecretRef；STEP-5 可选解析平台名称；
    // STEP-6 normalizeBotConfig + validateBotConfig；STEP-7 原子替换并刷新 runtime。
    async saveBot(params: BotSaveBotParams) {
      const config = await repo.readConfig();
      let bot: BotConfig = {
        ...params.bot,
        // id 会参与 credential key（bot:<id>:credential）与 context key（私聊键就是 id），
        // 不去空白会生成两套互不相认的凭据与状态，表现为“保存成功但重启后失效”。
        id: params.bot.id.trim(),
        // name 允许空（下面会用平台返回值回填）；只去空白，不做大小写等改写。
        name: params.bot.name.trim(),
        // allowedWorkspaces 是唯一 workspace 权限边界，空数组会被 normalize 成 "*"（全允许）；
        // 若在这里保留空数组，不同读取方对“空”的解释会漂移，等于权限口径不确定。
        allowedWorkspaces: normalizeAllowedWorkspaces(params.bot.allowedWorkspaces),
        allowedCommands: normalizeBotCommandPolicy(params.bot.allowedCommands),
        currentOptions: normalizeBotCurrentOptions(params.bot.currentOptions),
        // 回复粒度依赖 provider 能力（飞书/Lark 走卡片），必须按 provider 归一，
        // 否则旧配置里的普通消息模式会被静默保留，卡片链路永远不生效。
        replyMode: normalizeBotReplyGranularity(params.bot.provider, params.bot.replyMode),
      };
      // [资源] 凭据必须先于配置写入，且 key 由 bot.id 确定性派生：
      // 若配置写入随后失败，凭据只是“已存在但无人引用”的孤儿，下次保存会覆盖它；
      // 反过来先写配置再写凭据，一旦 secret 写入失败，磁盘上就留下指向不存在 secret 的
      // credentialRef，运行时启动轮询时才报错，暴露更晚也更难定位。
      if (params.credentialValue?.trim()) {
        const key = buildBotCredentialKey(bot.id);
        await deps.credentialService.save(key, params.credentialValue.trim());
        bot = { ...bot, credentialRef: key };
      }
      // webhook 密钥与主凭据分开存放（不同 key 后缀），这样“只轮换签名密钥”不必触碰 token；
      // 顺序同样是先写 secret 再回填引用，理由同上。
      if (params.webhookSecretValue?.trim()) {
        const key = buildBotWebhookSecretKey(bot.id);
        await deps.credentialService.save(key, params.webhookSecretValue.trim());
        bot = { ...bot, webhookSecretRef: key };
      }
      // 只在“刚给了新凭据”或“名称为空”时回查平台名称：其余情况保留用户已保存的名字，
      // 既省掉一次外部请求，也避免用户手改的名称被平台值覆盖。
      if (params.credentialValue?.trim() || !bot.name.trim()) {
        const adapter = providers[bot.provider];
        // [失败路径] 飞书/Lark 扫码建应用后应用信息接口有短暂不可读窗口，用退避重试兜住；
        // 其它 provider 没有这个已知窗口，只试一次，避免无谓延迟。
        const resolveRetryDelaysMs = isFeishuBotProvider(bot.provider) ? [0, 800, 1_800] : [0];
        let resolvedName: string | null | undefined = null;
        let lastResolveNameError: unknown;
        for (const retryDelayMs of resolveRetryDelaysMs) {
          if (retryDelayMs > 0) {
            // Bugfix: 飞书 / Lark 扫码创建应用后，应用信息接口可能短暂不可读；重试后再回填 Bot 名称。
            await delay(retryDelayMs);
          }
          try {
            resolvedName = await adapter?.resolveName?.(bot);
            // 拿到非空名称立即结束重试：后续退避只会白白增加保存耗时。
            if (resolvedName?.trim()) {
              break;
            }
          } catch (error) {
            // 先记下再继续重试；名称解析是“尽力增强”，不能因为一次网络抖动阻断
            // 带凭据的保存，否则用户会反复重试同一操作却始终失败。
            lastResolveNameError = error;
          }
        }
        if (resolvedName?.trim()) {
          bot = { ...bot, name: resolvedName.trim() };
        } else if (lastResolveNameError) {
          // 最终失败只降级为 warn（不含凭据内容）：名称缺失不影响 bot 基本可用。
          botsLogger.warn(
            undefined,
            `resolve bot name failed bot=${bot.id}: ${lastResolveNameError instanceof Error ? lastResolveNameError.message : String(lastResolveNameError)}`,
          );
        }
      }
      // 归一化必须早于校验：validateBotConfig 比较的是最终落盘形态；
      // 若先校验后归一化，归一化可能把两个 bot 收敛成同一 providerUserId / credentialRef，
      // 使“唯一绑定”“唯一轮询凭据”这两条约束在校验之后被绕过。
      bot = normalizeBotConfig(bot);
      validateBotConfig(config, bot);
      // 以 id 为准做替换而不是无脑 push：保存语义是 upsert，重复点击不会产生重复 bot。
      const bots = config.bots.filter((item) => item.id !== bot.id);
      bots.push(bot);
      // [事务] 配置落盘是本次操作的唯一原子点：writeBotConfig 随后会在同一 stateWriteTail 上
      // 失效不再匹配新配置的群授权（换绑/停用会换 authorizationId 并把未发送投递置 invalidated），
      // 所以这里不需要、也不能自己再清一遍群状态，否则会与它的整份 state 写回互相覆盖。
      const savedConfig = await writeBotConfig({ ...config, bots });
      // 三个 runtime 只在落盘成功后刷新，理由同 saveConfig：运行时跟随磁盘事实。
      telegramRuntime.scheduleRefresh(savedConfig);
      weixinRuntime.scheduleRefresh(savedConfig);
      feishuRuntime.scheduleRefresh(savedConfig);
      return bot;
    },
    // 只删密钥、保留 bot 条目：用于“换 token”或“临时断开”。
    // 顺序：先撤掉所有依赖该凭据的运行通道 → 清空配置里的引用与绑定身份 →
    // 原子落盘 → 清私聊 context → 刷新 runtime → 最后才删除密钥本体。
    async removeBotSecret(botId: string) {
      const config = await repo.readConfig();
      const bot = findBot(config, botId);
      if (!bot) {
        throw new Error(`Bot not found: ${botId}`);
      }
      // 三家的“停止”手段不同：Telegram 同步一次 enabled=false 的命令列表，
      // 飞书断 WebSocket，微信停 long polling。必须在写配置前停，
      // 否则删掉密钥后仍在跑的连接会继续用旧 token 拉消息，直到自己失败。
      if (bot.provider === "telegram") {
        // 故意不 await：命令清理是外部网络调用，失败只影响按钮列表，
        // 不能让它拖住或阻断本地的密钥移除（Runtime 内部已自行记录失败）。
        void telegramRuntime.syncCommands({ ...bot, enabled: false });
      }
      if (isFeishuBotProvider(bot.provider)) {
        // stopWebSocket 只发起停止，不等待握手结束；后续配置写入不再依赖旧连接状态。
        feishuRuntime.stopWebSocket(bot.id);
      }
      if (bot.provider === "weixin") {
        weixinRuntime.stopPolling(bot.id);
      }
      // Bugfix: 只移除密钥时如果保留旧绑定身份，UI 会显示“已连通”，但运行时已经没有 token 可用。
      // 这里同步清理绑定状态，让 Bot token 行回到可重新添加的状态。
      const nextBot = normalizeBotConfig({
        ...bot,
        credentialRef: undefined,
        webhookSecretRef: undefined,
        // 绑定身份一并清空：token 没了还留着 providerUserId，新 token 绑到别的账号时
        // 会被 validateBotConfig 的“同 provider 唯一绑定”挡住，表现为永远绑不上。
        providerUserId: undefined,
        displayName: undefined,
        // feishuAppId 是应用身份而非用户身份，只有飞书系必须清：
        // 保留旧 appId 会让新凭据被当成旧应用继续使用；其它 provider 无关，原样保留。
        feishuAppId: isFeishuBotProvider(bot.provider) ? undefined : bot.feishuAppId,
      });
      // [事务] 只替换单条 bot；writeBotConfig 会因 credentialRef 变化把该 bot 的群授权
      // 整体失效（authorizationId 换新、未发送投递置 invalidated）。这是刻意的：
      // 凭据变了，旧群授权不能再代表新身份，继续沿用等于让旧群消息用新身份被回复。
      const savedConfig = await writeBotConfig({
        ...config,
        bots: config.bots.map((item) => (item.id === bot.id ? nextBot : item)),
      });
      // 私聊 context 的键就是 botId；update 返回 undefined 即删除该条目，
      // 让下一条消息从干净状态重建，而不是残留旧的 activeTaskId / privateBindingId。
      await repo.updateContext(bot.id, () => undefined);
      telegramRuntime.scheduleRefresh(savedConfig);
      weixinRuntime.scheduleRefresh(savedConfig);
      feishuRuntime.scheduleRefresh(savedConfig);
      // [资源] 密钥删除放在配置落盘之后：此时配置已不再引用它们，删除失败最多留下
      // 无人引用的孤儿 secret（可被下次保存覆盖或人工清理）；反过来先删密钥，
      // 一旦后续写配置失败，磁盘上的 credentialRef 就指向不存在的 secret。
      if (bot.credentialRef) {
        await deps.credentialService.delete(bot.credentialRef);
      }
      if (bot.webhookSecretRef) {
        await deps.credentialService.delete(bot.webhookSecretRef);
      }
      return nextBot;
    },
    // 删除整条 bot：与 removeBotSecret 相同的“先撤通道、再落盘、最后删密钥”顺序，
    // 但允许 bot 不存在——重复删除是幂等 no-op（UI 双击或请求重放不应报错）。
    async deleteBot(botId: string) {
      const config = await repo.readConfig();
      const bot = findBot(config, botId);
      // 三个 if 都用可选链：bot 已不存在时直接跳过撤销，最终仍执行一次状态清理与刷新。
      if (bot?.provider === "telegram") {
        void telegramRuntime.syncCommands({ ...bot, enabled: false });
      }
      if (bot && isFeishuBotProvider(bot.provider)) {
        feishuRuntime.stopWebSocket(bot.id);
      }
      if (bot?.provider === "weixin") {
        weixinRuntime.stopPolling(bot.id);
      }
      // [事务] 从数组里过滤掉即删除；writeBotConfig 会按“bot 消失”判为换绑，
      // 连带失效该 bot 的所有群授权并广播 group-state。
      await writeBotConfig({
        ...config,
        bots: config.bots.filter((item) => item.id !== botId),
      });
      // 不传 savedConfig：配置已从文件删除，scheduleRefresh() 重新读盘即可；
      // 飞书的 WebSocket 停止已在上方显式完成，这里不需要再刷新它的连接。
      telegramRuntime.scheduleRefresh();
      weixinRuntime.scheduleRefresh();
      // 清掉私聊 context（键即 botId）；群/话题 context 已由 writeBotConfig 按换绑失效。
      await repo.updateContext(botId, () => undefined);
      // [资源] 同 removeBotSecret：配置不再引用后再删 secret，失败只留孤儿不会留悬空引用。
      if (bot?.credentialRef) {
        await deps.credentialService.delete(bot.credentialRef);
      }
      if (bot?.webhookSecretRef) {
        await deps.credentialService.delete(bot.webhookSecretRef);
      }
    },
    // 连通性自检：adapter.test 内部会发一次真实平台请求（校验 token / 取自身信息等）。
    // 返回值回填 provider，便于 UI 在对应行原地展示；这里不捕获异常，
    // 让调用方区分“配置问题”（返回 ok:false）与“调用本身失败”（抛出）。
    async testBot(botId: string): Promise<BotTestResult> {
      const config = await repo.readConfig();
      const bot = findBot(config, botId);
      if (!bot) {
        return { ok: false, message: "Bot not found." };
      }
      const adapter = providers[bot.provider];
      // 预留 provider（枚举里有、但还没接入）没有 adapter：这不是异常，
      // 而是可解释的“尚未支持”，所以返回 ok:false 而不是抛出。
      if (!adapter) {
        return {
          ok: false,
          message: `${bot.provider} is reserved for a future version.`,
          provider: bot.provider,
        };
      }
      return { ...(await adapter.test(bot)), provider: bot.provider };
    },
    // 生成一次性绑定码，只存在内存 Map，不落盘。
    // [权衡] bindCodes 只存内存是刻意的：绑定码是短时凭证，重启即失效比“从磁盘复活旧码”更安全；
    // 代价是进程重启会让界面上已展示的码失效，用户需要重新生成。
    // [失败路径] 这里不校验 allowedWorkspaces 是否落在 bot 现有权限内：绑定成功时
    // handleBind 会用码里的 allowedWorkspaces 覆盖 bot 配置，因此调用方必须已鉴权。
    async createBindCode(params: BotCreateBindCodeParams): Promise<BotBindCodeResult> {
      const config = await repo.readConfig();
      // [权衡] 右侧与左侧同值，等价于直接写 params.botId；保留这个写法只是保留了
      // “缺省 botId 时可回退”的意图位置，当前没有任何回退来源。
      const botId = params.botId ?? params.botId;
      if (!botId) {
        throw new Error("Bot id is required.");
      }
      // 必须确认 bot 真实存在：否则会生成一个永远绑定不上任何 bot 的死码，
      // 用户只能在“码无效”的提示里反复试错，无法判断是码过期还是 bot 被删。
      const bot = findBot(config, botId);
      if (!bot) {
        throw new Error(`Bot not found: ${botId}`);
      }
      // createCode 是 3 字节随机的大写十六进制：够短好念，安全性依赖
      // “私聊身份 + 短 TTL + 使用后立即 delete”，而不是码本身的熵。
      const code = createCode();
      // ttlMs 没有上下限收敛：0 或负数会立即过期，超大值等于长期有效码，
      // 由调用方（已鉴权的设置页）自行给出合理值。
      const expiresAt = Date.now() + (params.ttlMs ?? BOT_BIND_CODE_TTL_MS);
      // 缺省 "*"（全部 workspace）：绑定码由管理员在已鉴权界面生成，不传即沿用默认授权，
      // 而不是“无任何 workspace 权限”这种会让新用户立刻卡住的默认。
      const allowedWorkspaces = normalizeAllowedWorkspaces(
        params.allowedWorkspaces ?? [ALL_BOT_WORKSPACES],
      );
      // 键就是 code（大写），消费端 handleBind 用 trim + toUpperCase 查表；
      // 没有定时清理：过期码只在被使用时判失败，条目数量受管理操作次数约束。
      bindCodes.set(code, {
        botId: botId,
        code,
        allowedWorkspaces,
        expiresAt,
      });
      return { code, expiresAt };
    },
    // 查询群成员显示名（mention 解析用）。三条约束：
    // 1) 只对“当前 bot 是群 owner 且群已启用”的群开放（INV-01：群授权只来自持久状态）；
    // 2) 查询前后各鉴权一次，期间停用/换绑/换凭据则丢弃结果；
    // 3) 只读不写：不缓存名单，避免过期成员名被长期用于 mention。
    async getGroupMemberNames(params: { botId: string; chatId: string }) {
      // 不带 threadId：成员名单是群级事实，不随话题变化，因此读的是群默认 context。
      const key = getBotConversationKey({ ...params, chatType: "group" });
      const authorize = async () => {
        const bot = findBot(await repo.readConfig(), params.botId);
        const group = (await repo.readState()).bots[key]?.group;
        // 四个条件缺一不可：bot 启用、已完成私聊绑定（providerUserId 决定 owner 身份）、
        // 群已启用、且群 owner 就是当前绑定用户。任一不满足都直接抛错，
        // 不能退化成“返回空名单”——否则调用方无法区分“无权限”和“群里没别人”。
        if (
          !bot?.enabled ||
          !bot.providerUserId ||
          !group?.enabled ||
          group.ownerId !== bot.providerUserId
        )
          throw new Error("Group member names are unavailable for this group");
        return { bot, group };
      };
      // [失败路径] provider 调用是外部网络请求，可能耗时数百毫秒；这段时间里群可能被停用，
      // 所以 after 必须重新鉴权，不能复用 before 的判定结果。
      const before = await authorize();
      // provider 未实现该能力时返回 undefined，这里退化成空对象而不是抛错：
      // 成员名只是展示增强，拿不到名单不应阻断“发消息”本身。
      const names =
        (await providers[before.bot.provider]?.getGroupMemberNames?.(before.bot, params.chatId)) ??
        {};
      const after = await authorize();
      // 查询期间停用、重新授权或切换凭据后，旧请求不得将姓名带回新会话。
      // 比对 authorizationId / providerUserId / credentialRef / feishuAppId / provider：
      // 任一变化都意味着“发出请求的身份”已不是“接收结果的身份”，结果必须整体丢弃。
      if (
        before.group.authorizationId !== after.group.authorizationId ||
        before.bot.providerUserId !== after.bot.providerUserId ||
        before.bot.credentialRef !== after.bot.credentialRef ||
        before.bot.feishuAppId !== after.bot.feishuAppId ||
        before.bot.provider !== after.bot.provider
      )
        throw new Error("Group authorization changed while resolving names");
      return names;
    },
    // authorizeTopicResource 只鉴权不下载：给界面一个“这条话题附件现在能否读取”的预检口。
    // [权衡] 依赖注入只给 readState / readConfig，故意不给 readMessage / download，
    // 让预检路径在类型层面就不可能产生网络读取（INV-06：先授权、后读取）。
    async validateTopicResource(params) {
      await authorizeTopicResource(params, {
        readState: () => repo.readState(),
        readConfig: () => repo.readConfig(),
      });
    },
    // 读取话题附件：授权 → 取原生消息 → 校验 resourceIndex → 下载 → 再鉴权 → 校验大小。
    // 这条顺序全部由 readAuthorizedTopicResource 保证，本方法只提供 provider 适配器：
    // 若在这里“先下载再鉴权”，伪造的 chatId / threadId 就能拉取任意附件。
    // 返回 base64 是 host 协议口径（IPC 只能传字符串），不是存储格式。
    async readTopicResource(params) {
      // debug 级：每条资源读取都会打一行，属于与消息同数量级的高频日志。
      botsLogger.debug(
        `topic resource read task=${params.taskId} message=${params.messageId} trace=${params.trace?.traceId ?? "none"}`,
      );
      const result = await readAuthorizedTopicResource(params, {
        readState: () => repo.readState(),
        readConfig: () => repo.readConfig(),
        readMessage: async (bot, target, signal) => {
          // provider 缺失说明该 provider 未实现能力（或配置已被删）：显式抛错，
          // 而不是返回空消息被上层误判成“消息已删除”。
          const reader = providers[bot.provider]?.readTopicResourceMessage;
          if (!reader) throw new Error("Topic resource provider unavailable");
          return reader(bot, target, signal);
        },
        download: async (bot, attachment, target, signal) => {
          const result = await providers[bot.provider]?.downloadAttachment?.(
            bot,
            attachment,
            {
              botId: bot.id,
              provider: bot.provider,
              chatType: "group",
              chatId: target.chatId,
              threadId: target.threadId,
              // [失败路径] 这里的 ! 是安全的：authorizeTopicResource 已要求
              // group.ownerId === bot.providerUserId，能走到下载说明该字段必然存在。
              providerUserId: bot.providerUserId!,
              providerMessageId: target.messageId,
            },
            signal,
          );
          // 下载器缺失或 provider 不支持时返回 undefined：显式转成错误，
          // 避免把“能力缺失”当成“附件为空”。
          if (!result) throw new Error("Topic resource download unavailable");
          return result;
        },
      });
      // [权衡] kind 过滤放在下载之后：归档校验允许 post（图文消息），但 host 只接受
      // file / image，代价是 post 会先被完整下载再拒绝。若要把成本压到零，
      // 应把 kind 校验前移到 provider 读取阶段，而不是在这里放宽类型。
      if (result.attachment.kind !== "file" && result.attachment.kind !== "image")
        throw new Error("Topic resource format unsupported");
      return {
        kind: result.attachment.kind,
        filename: result.attachment.filename,
        // mimeType 缺失时给通用二进制类型，避免 host 侧按 undefined 自行猜测。
        mimeType: result.attachment.mimeType || "application/octet-stream",
        // 用实际字节长度而不是附件声明大小：声明值可能被伪造，或与实际下载内容不符。
        sizeBytes: result.data.byteLength,
        dataBase64: Buffer.from(result.data).toString("base64"),
      };
    },
    // 话题详情：只读持久状态 + 任务级摘要，不触碰 IM。
    // 三重范围校验（任务、workspace、owner）全部基于持久状态，
    // 任何一项不匹配都抛错，防止拿一个任务的 taskId 去读另一个任务的归档统计。
    async getTopicDetails(params) {
      const state = await repo.readState();
      // key 带 threadId：话题 context 独立于群默认 context，两者不能互相回退，
      // 否则话题统计会读到群级任务的历史。
      const context =
        state.bots[
          getBotConversationKey({
            botId: params.botId,
            chatId: params.chatId,
            chatType: "group",
            threadId: params.threadId,
          })
        ];
      // 任务级 workspace 优先：同一话题切换过 workspace 时，按任务记录而不是当前 context，
      // 否则历史任务的材料会被新 workspace 的范围校验误判为越权。
      const workspace = context?.group?.taskWorkspaces?.[params.taskId] ?? context;
      // 统一 key 口径：workspaceIdentity 优先、路径兜底（与全局约定一致），
      // 避免同一远端 workspace 换路径后被误判成不同范围。
      if (
        !context?.group?.taskIds.includes(params.taskId) ||
        !workspace ||
        (workspace.workspaceIdentity?.trim() || workspace.workspacePath) !==
          (params.workspaceIdentity?.trim() || params.workspacePath)
      )
        throw new Error("Topic task scope mismatch");
      // owner 校验：只有当前绑定用户能看话题统计（群成员身份不足以授权，见 INV-01）。
      const bot = findBot(await repo.readConfig(), params.botId);
      if (!bot || context.group.ownerId !== bot.providerUserId)
        throw new Error("Topic owner scope mismatch");
      // 只统计 admission === "accepted" 的输入：pending / rejected 的材料还没成为
      // 已归档历史，计入会让“消息数”在用户看来凭空增长。
      const batches = Object.values(context.group.inputs ?? {})
        .filter((input) => input.taskId === params.taskId && input.admission === "accepted")
        .flatMap((input) => (input.source.topicContext ? [input.source.topicContext] : []));
      // historyEnabled 是群级开关，存在群默认 context（无 threadId）上；
      // 话题侧不复制该字段，避免两处副本不一致时无法判断哪份为准。
      const parent =
        state.bots[
          getBotConversationKey({ botId: params.botId, chatId: params.chatId, chatType: "group" })
        ];
      // [失败路径] 远端 workspace 的 runtime 未连接时这里会抛 BotAdminRequiredError，
      // 由上层转成“请 /重连 后重试”，不能静默返回空摘要（否则用户以为历史为空）。
      const service = await resolveZCodeTaskServiceForContext({ ...context, ...workspace });
      // 摘要由任务级服务提供（CLI 侧事实）；provider 未实现时按空数组处理。
      const summaries =
        (await service.readBotTopicSummaries?.({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        })) ?? [];
      return {
        // 用 Set 去重：同一条消息可能被多个 accepted batch 重复引用（续接/重试），
        // 直接累加会把同一句话算成两条。
        messageCount: new Set(batches.flatMap((batch) => batch.messages.map((record) => record.id)))
          .size,
        // 任一批次有缺口就为 true：历史不完整时不能对用户声称“已全量读取”。
        hasGap: batches.some((batch) => batch.hasGap),
        // 缺省视为开启（!== false）：老状态文件没有该字段时按历史可用处理。
        historyEnabled: parent?.group?.historyEnabled !== false,
        summaries,
      };
    },
    // 材料准备失败后的重试入口：只允许重试“仍可重试”的失败材料。
    // 参数里的 botId / chatId / threadId 只用于定位会话，授权与去重全部回到持久状态判定。
    async retryTopicPreparation(params) {
      const key = getBotConversationKey({ ...params, chatType: "group" });
      const context = (await repo.readState()).bots[key];
      const bot = findBot(await repo.readConfig(), params.botId);
      // 与其它入口一致的四要素校验（bot 启用、群启用、owner 未变、任务未切换）；
      // 任一变化都说明用户看到的那条失败材料已属于旧会话，重试会打到错误的任务上。
      if (!bot?.enabled || !context?.group?.enabled || context.group.ownerId !== bot.providerUserId)
        throw new Error("Topic preparation target is no longer authorized");
      if (context.activeTaskId !== params.taskId) throw new Error("Topic preparation task changed");
      // workspace 也必须一致：同一话题切过 workspace 后，旧材料不能提交到新目录。
      if (
        getWorkspaceKey(context.workspacePath, context.workspaceIdentity) !==
        getWorkspaceKey(params.workspacePath, params.workspaceIdentity)
      )
        throw new Error("Topic preparation workspace changed");
      // [并发] 先等该话题正在进行的续接排空：续接可能正把同一批消息提交为 accepted，
      // 不等它结束就查重，会出现“查的时候还没提交、提交后我们又重发一次”的双重入。
      await topicContinuations.get(key)?.settled();
      // 已提交命令只能查询原接收结果；材料重试不能绕过去重，留下永久准备状态。
      // 这里重新读一次 state（而不是复用上面的 context）：settled 之后状态可能已经前进。
      const latest = (await repo.readState()).bots[key];
      if (
        Object.values(latest?.group?.inputs ?? {}).some(
          (input) =>
            input.source.messageId === params.messageId ||
            input.source.messages?.some((original) => original.messageId === params.messageId),
        )
      )
        throw new Error("Topic input was already submitted; preparation cannot be retried");
      // retry 只对 status === "failed" 的条目返回消息，其它状态返回 undefined，
      // 对应“已经不再可重试”，防止准备中/等待停止的材料被并发重放。
      const message = topicPreparation.retry(key, params.messageId);
      if (!message) throw new Error("Topic preparation is no longer retryable");
      // 先置 preparing 再广播：界面立刻从 failed 变为进行中，减少用户连点造成的重复提交。
      topicPreparation.update(key, [params.messageId], "preparing");
      await publishTopicPreparation();
      // 走完整入站主流程（service 是同一个公开实例）而不是直接投递：
      // 群授权、入站幂等键占位与 admission 都会在 handleInboundMessage 内重新校验（INV-03），
      // 重试不能走旁路，否则同一消息可能被执行两次。
      const replies = await service.handleInboundMessage(message);
      // 回复逐条发送：任一条失败会中断后续并把异常抛给 RPC；已发送部分依赖
      // deliveryId 幂等，不会被重复投递（INV-07）。
      for (const reply of replies) await sendOutbound(bot, reply);
    },
    // 让 Agent 主动向所在频道回话：解析唯一任务绑定 → 校验授权 → 幂等投递。
    // 全部规则在 replyToBotChannel 内：binding 必须唯一、授权 ID 必须匹配、
    // deliveryId 由 (botId, taskId, inputId, toolCallId) 派生，重放返回原回执。
    async replyToChannel(request) {
      return replyToBotChannel(request, {
        readState: () => repo.readState(),
        readConfig: () => repo.readConfig(),
        // 成员名单只用于 mention 名称解析；失败由 channelReply 降级为待澄清结果。
        listMembers: async (bot, chatId) => {
          const read = providers[bot.provider]?.getGroupMemberNames;
          if (!read) throw new Error("Channel member lookup unavailable");
          return read(bot, chatId);
        },
        // 投递必须复用群投递 sender：节流、授权复核、幂等、终态写回都在里面（INV-07），
        // 直接调用 provider adapter 会绕开这些约束。
        deliver: (bot, chatId, threadId, result) =>
          getGroupDeliverySender(bot, chatId, threadId)(result),
      });
    },
    // 对外状态快照：把内存投影叠加到持久状态上，但不写回。
    // 两处投影：topicPreparation 只存在于内存（未提交材料），deliveries 中正在发送的记录
    // 会被 project 成 pending——崩溃恢复用的 unknown 不能直接暴露成 UI 告警（INV-07）。
    async getBotStates() {
      return Object.entries((await repo.readState()).bots).map(([key, context]) => {
        // 只有群/话题 context 才有材料准备态；私聊 context 直接原样返回。
        if (context.group)
          context = {
            ...context,
            group: { ...context.group, preparation: topicPreparation.snapshot(key) },
          };
        const sender = groupDeliverySenders.get(key);
        // 没有 sender 说明该群从未产生过投递：保留磁盘上的原始 deliveries，
        // 不能凭空生成一个空投影，否则界面会误以为投递记录被清空。
        if (!context.group || !sender) return context;
        return {
          ...context,
          group: {
            ...context.group,
            deliveries: Object.fromEntries(
              Object.entries(context.group.deliveries ?? {}).map(([id, result]) => [
                id,
                sender.project(result),
              ]),
            ),
          },
        };
      });
    },
    // 人工对账：只有 status === "unknown"（发送中断、结果不确定）的记录允许被确认
    // 收到或未收到。这是 INV-07 的兜底口：unknown 不能自动重发（会重复），
    // 也不能永远挂着，必须由用户看到平台上的真实消息后回填终态。
    async reconcileGroupResult(params: {
      botId: string;
      chatId: string;
      deliveryId: string;
      threadId?: string;
      received: boolean;
    }) {
      const key = getBotConversationKey({
        botId: params.botId,
        chatType: "group",
        chatId: params.chatId,
        threadId: params.threadId,
      });
      let reconciled: BotGroupDelivery | undefined;
      // [并发] 必须与所有其它 state 写入串行：这里是“读整份 state → 判断 → 整份写回”，
      // 不串行会把并发写入的 deliveries / activeTaskId 覆盖掉（INV-02、INV-10）。
      await serializeStateWrite(async () => {
        const bot = findBot(await repo.readConfig(), params.botId);
        const state = await repo.readState();
        const context = state.bots[key];
        const result = context?.group?.deliveries?.[params.deliveryId];
        // 七个条件共同保证“这条结果仍属于当前有效会话”：bot/群启用、owner 未换、
        // 结果存在、属于当前任务、仍是 unknown、且没有活跃发送。
        // 若允许 inFlight 时对账，人工写入会与发送完成后的写回互相覆盖，产生错误的终态。
        if (
          !bot?.enabled ||
          !context?.group?.enabled ||
          context.group.ownerId !== bot.providerUserId ||
          !result ||
          result.taskId !== context.activeTaskId ||
          result.status !== "unknown" ||
          groupDeliverySenders.get(key)?.isInFlight(params.deliveryId)
        ) {
          throw new Error("Saved group result cannot be reconciled in the current state");
        }
        // 只改状态与时间戳，保留 text / providerMessageId 等原始投递内容：
        // 对账不是重写消息，只是补一个终态。lastError 清空表示“已有确定结论”。
        reconciled = {
          ...result,
          status: params.received ? "sent" : "failed",
          lastError: undefined,
          updatedAt: Date.now(),
        };
        // 展开赋值而不是原地 mutate：读到的 state 是 JSON 解析结果，但保持不可变写法
        // 能防止后续维护者误以为可以省略 writeState。
        context.group.deliveries = { ...context.group.deliveries, [result.id]: reconciled };
        await repo.writeState(state);
      });
      // [失败路径] 广播失败不影响对账结果：界面可通过下次读取拿到新状态，
      // 因此吞成 undefined，而不是让调用方以为对账失败并重试。
      await deps.broadcastService
        ?.send({
          channel: "bots:group-state",
          payload: { botId: params.botId, chatId: params.chatId },
        })
        .catch(() => undefined);
      // 非空断言成立：serializeStateWrite 只有两条出口——上面抛错，或成功执行到赋值。
      return reconciled!;
    },
    // 手动重发：只对 status === "failed" 的记录生效。sender 的 retry=true 只放开
    // failed 一道闸，sent / invalidated 直接返回，unknown 必须走 reconcile 而不能重发。
    async resendGroupResult(params: {
      botId: string;
      chatId: string;
      threadId?: string;
      deliveryId: string;
    }) {
      // 仅飞书/Lark：群结果投递依赖它们的卡片与引用能力，其它 provider 没有该语义，
      // 静默“重发成功”会让用户以为消息已到达。
      const bot = findBot(await repo.readConfig(), params.botId);
      if (!bot || !isFeishuBotProvider(bot.provider)) throw new Error("Group bot unavailable");
      const key = getBotConversationKey({
        botId: params.botId,
        chatType: "group",
        chatId: params.chatId,
        threadId: params.threadId,
      });
      // 这里先读一次只为“不存在就快速失败”；授权与终态判定在 sender 内部再读一次，
      // 因为两次读取之间群可能被停用或任务已切换。
      const result = (await repo.readState()).bots[key]?.group?.deliveries?.[params.deliveryId];
      if (!result) throw new Error("Saved group result unavailable");
      // 第二个参数 true 是 retry 语义：failed 记录会重新走 unknown → 发送 → 终态，
      // 全程经 sender 的 inFlight 去重，连点不会产生两条消息。
      await getGroupDeliverySender(bot, params.chatId, params.threadId)(result, true);
      // 返回重新读盘后的记录：providerMessageId / status 以 sender 写回的为准，
      // 不能把本地旧快照当作发送结果返回。
      return (await repo.readState()).bots[key]?.group?.deliveries?.[params.deliveryId] ?? result;
    },
    // 供界面开关群启用的编程入口：复用 /enable、/disable 的同一条激活链路，
    // 保证授权 ID 轮换、话题卡片失效、订阅恢复等副作用与命令路径完全一致。
    // [权衡] 这里把 actor.providerUserId 设成 bot.providerUserId，等于自证 owner；
    // 安全性完全依赖调用方（RPC/host）已鉴权，该方法不能暴露给不可信通道（INV-01）。
    async setGroupEnabled(params: { botId: string; chatId: string; enabled: boolean }) {
      // 没有 providerUserId 说明 bot 还没完成私聊绑定，无法确定 owner，直接拒绝。
      const bot = findBot(await repo.readConfig(), params.botId);
      if (!bot?.providerUserId) throw new Error("Bot owner unavailable");
      // text 只是占位：handleGroupActivation 按 enabled 参数分派，text 仅用于回复与日志上下文。
      await handleGroupActivation(
        {
          botId: bot.id,
          actor: {
            provider: bot.provider,
            botId: bot.id,
            chatType: "group",
            chatId: params.chatId,
            providerUserId: bot.providerUserId,
          },
          text: params.enabled ? "/enable" : "/disable",
        },
        params.enabled,
      );
      // [失败路径] handleGroupActivation 对非飞书/Lark 返回“仅支持私聊”的回复而不是抛错，
      // 本方法丢弃返回值，因此在这些 provider 上开关是静默 no-op，界面需另行限制入口。
    },
    // 私聊回复失败后的手动重试：失败消息只存在内存 failedPrivateDeliveries 中
    // （不落盘，重启即失效）。七个校验条件把“这条失败消息”重新绑定到当前会话：
    // 同一 deliveryId、未在发送中、bot 仍启用、私聊绑定未变、任务未变、接收者未变。
    // 任一不满足都抛错——旧任务/旧绑定的失败消息绝不能重发到新会话。
    async retryPrivateDelivery({ botId, deliveryId }) {
      const failed = failedPrivateDeliveries.get(botId);
      const bot = findBot(await repo.readConfig(), botId);
      const context = (await repo.readState()).bots[botId];
      // 微信的接收者是扫描绑定时写入的 privateRecipientId，其它 provider 就是绑定用户，
      // 两者口径不同，必须按 provider 取值后再与失败消息比对。
      const recipient =
        bot?.provider === "weixin" ? context?.privateRecipientId : bot?.providerUserId;
      if (
        !failed ||
        failed.id !== deliveryId ||
        failed.sending ||
        !bot?.enabled ||
        context?.privateBindingId !== failed.bindingId ||
        context?.activeTaskId !== failed.taskId ||
        recipient !== failed.message.providerUserId
      )
        throw new Error("Private delivery is no longer available");
      // [并发] 检查与置位之间没有 await，所以两次并发点击不可能同时通过：
      // 第二个调用会看到 sending === true 并被上面的条件拒绝。
      failed.sending = true;
      try {
        // 复用统一出站函数：飞书的拆分/引用降级、微信的会话 token 等都在内部处理。
        await sendOutbound(bot, failed.message);
        // 成功后再确认 Map 里仍是同一条记录：期间 bot 可能被删除/重置并写入新的失败项，
        // 此时不能连带清掉新记录，也不能清掉新记录对应的 runtime 错误提示。
        if (failedPrivateDeliveries.get(botId) === failed) {
          failedPrivateDeliveries.delete(botId);
          const runtime = runtimeByBotId.get(botId);
          if (runtime)
            setRuntimeStatus({ ...runtime, deliveryRetryId: undefined, deliveryError: undefined });
        }
      } finally {
        // [资源] 无论成功失败都要放开 sending：失败时保留记录供再次重试，
        // 卡在 sending === true 会让这条消息永久无法重发。
        failed.sending = false;
      }
    },
    // 重置单个会话 context（私聊键是 botId，群/话题是 conversation key）。
    // updateContext 的 update 返回 undefined 即删除条目，删除在文件锁内完成（INV-10）。
    async resetBotState(contextKey: string) {
      await repo.updateContext(contextKey, () => undefined);
      // 随后按当前配置重建私聊订阅，避免“刚重置就收不到消息”。
      // [权衡] 只清持久 context，不清内存投影（topicPreparation / groupDeliverySenders /
      // failedPrivateDeliveries / bindCodes）：这些投影各自带授权校验或会被下一次事件覆盖，
      // 但 reset 到下一次事件之间，界面仍可能看到旧的准备态。
      await reconcilePrivateSynchronization(contextKey);
    },
    // 自动化运行的事件监听：实现已在文件内提供，这里只把能力挂到公开服务接口上。
    watchAutomationRun,
    async handleInboundMessage(message: BotInboundMessage) {
// [入口] handleInboundMessage 是 Bot 侧唯一入站分派点，固定七段流水线：
//   ① 关闭闸门 ② 机器人身份闸门 ③ 群可见性（话题/非话题）闸门
//   ④ 话题 actor 归一化与 alias/根消息路由 ⑤ 命令解析与群控制标记
//   ⑥ 命令分支（同步副作用）或消息 admission ⑦ 群回执装饰。
// 这里只维护投递/话题/交互等外部协作状态；conversation 正文事实属 CLI 的
// CommandInbox；常规分支只返回 replies，仅"运行时能力缺失"这类配置错误才显式抛错。
// INV-01：权限只能由 BotGroupSource/owner 元数据收紧，正文与回调 payload 不能提升。
// INV-03：幂等键占位在 enqueueInboundProcessing 内、所有副作用之前。
// [失败路径] INV-12：关闭后入站消息直接返回空数组——不读 state、不占幂等键、
// 不发网络请求。反过来（放行）会让关闭中的排队消息重新拉起 provider runtime
// 或写回状态，使 disposeAllAndWait 承诺的"已收口"变成假象。
      if (shutdownPromise) return [];
// 机器人身份（senderType=app）在群内只允许一种入口：普通群里真人已启用、
// 且以原生 @ 触发的普通消息。卡片回调与 elicitation 响应都可由机器人自己
// 构造 payload，一旦放行就能形成"自问自答"的控制回路，绕过 owner 判定（INV-01）。
      if (message.senderType === "app") {
        // 机器人只能使用真人已启用的群/话题；原生 @ 可触发普通群输入，不能获取控制权限。
        if (
          message.actor.chatType !== "group" ||
          message.groupCardAction ||
          message.elicitationResponse
        )
          return [];
// 读取群级状态用「去掉 threadId 的会话键」：机器人可见性只由群配置决定，
// 与具体话题无关。若把 threadId 留在键里，同一群在不同话题下会得到不同结论，
// 机器人能在用户已退出的话题里继续发言。
        const topic = (await repo.readState()).bots[
          getBotConversationKey({ ...message.actor, conversationThreadId: undefined })
        ];
        if (!topic?.group?.enabled) return [];
// [并发] 先判 threadId 再判 topicActive：话题关闭（topicActive !== true）
// 是用户显式 /leave 的结果，必须优先于"原生 @"生效；
// 否则退出的任务会被一条 @ 重新激活，与 /leave 的契约冲突。
        if (message.actor.threadId) {
          if (topic.group.topicActive !== true) return [];
// 非话题消息要求"真 @ 了机器人"且群不是 topic 模式。topic 模式的群根消息
// 由后面的 resolveTopic 反查归属，不能在这里进入默认任务；
// 提前拒绝可避免根事件绕过话题路由造成双任务。
        } else if (message.mentionedBot !== true || topic.group.chatMode === "topic") {
          return [];
        }
      }
// [权衡] 把 mentionedBot 归一成布尔值写回 message，而不是各处判空 undefined：
// 下游存在 `=== false` / `=== true` 的严格比较，保留 undefined 会让"未提供"
// 与"明确非 @"在同一条消息的不同判断里得出相反结论，形成难以复现的路由错误。
      message = {
        ...message,
        actor: { ...message.actor, mentionedBot: message.mentionedBot === true },
      };
// [并发] 群内未 @ 机器人的消息默认不处理，只有三种可信例外：
// 已激活话题内的消息、话题未定态且根消息属于本机器人、本进程内刚登记的续接。
// 三者全部来自 BotGroupSource 或此前写入的状态，不看正文（INV-01）；
// 若允许"正文里出现 bot 名字"就放行，任何人都能构造一次未授权的任务投递。
      if (
        message.actor.chatType === "group" &&
        message.mentionedBot === false &&
        !message.groupCardAction
      ) {
        const topic = (await repo.readState()).bots[
          getBotConversationKey({ ...message.actor, conversationThreadId: undefined })
        ];
// 三个条件整体取反才放行，缺一不可：
// (1) 无 threadId 的非话题消息一律丢弃（群根消息不属于任何任务）；
// (2) topicActive===false 表示用户已 /leave，必须尊重；
// (3) topicActive 未定态时才允许用 topicRootIsCurrentBot 判定归属，
//     而 topicContinuations 覆盖"刚续接、状态尚未落盘"的短窗口。
// [失败路径] 删掉 (3) 会让续接后的第一条话题消息因状态未刷新而被静默吞掉。
        if (
          !message.actor.threadId ||
          topic?.group?.topicActive === false ||
          (!topic?.group?.topicActive &&
            message.topicRootIsCurrentBot !== true &&
            !topicContinuations.has(getBotConversationKey(message.actor)))
        )
          return [];
      }

// 话题内统一改用「无 conversationThreadId」的 actor：权威会话是任务级身份，
// thread 只是投递通道。把 threadId 留在键里会让同一任务在不同话题下被认成
// 两个会话，出现"状态在 A、回复发到 B"的分裂。
      if (message.actor.chatType === "group" && message.actor.threadId) {
        const actor: BotActor = { ...message.actor, conversationThreadId: undefined };
        const state = await repo.readState();
// 该话题首次接入时状态尚不存在，需要走 alias 一次性迁移检查。
// alias 是安全网而非路由：只有确认旧任务确实结束，才允许把话题重新绑到当前任务，
// 否则两个执行体会同时向同一话题写结果。
        if (!state.bots[getBotConversationKey(actor)]) {
          // alias 仅用于一次性安全迁移检查，不能再把话题路由到默认任务。
// [权衡] 全量遍历 bots 而不建 botId 索引：迁移是冷路径，只发生一次；
// 维护第二份索引带来的"索引与真相不一致"风险，远大于这里的一次线性扫描。
          for (const candidate of Object.values(state.bots)) {
            const group = candidate.group;
            if (!group || candidate.botId !== actor.botId || group.chatId !== actor.chatId)
              continue;
// 无 alias 即非迁移目标，continue 而非 return：
// 同一 bot 可能有多个候选上下文需要逐个检查。
            const alias = group.topicAliases?.[actor.threadId!];
            if (!alias) continue;
            // 默认会话可能已切换工作区；迁移检查必须使用旧任务自己的完整工作区身份。
            const workspace = group.taskWorkspaces?.[alias.taskId] ?? candidate;
// 关键：解析 service 必须用「alias 对应工作区」而不是默认会话的 workspace。
// 默认会话可能已切到另一个项目，用它的 workspace 去问 blockReason
// 会把"旧任务仍在跑"误判成"空闲"，从而允许重复接入同一 taskId。
            const service = await resolveZCodeTaskServiceForContext({ ...candidate, ...workspace });
// 只要服务未实现 getBotGroupTaskBlockReason，或它返回非空 reason，
// 都视为旧任务可能仍在执行——宁可拒绝接入，也不冒双写风险。
// [失败路径] 拒绝通过 createOutbound 回给用户，不抛异常：
// 这是用户可恢复的状态（结束旧任务后重试），不该中断整条入站链路；
// 抛错的后果是上游把消息当成基础设施失败并重试，反而放大冲突。
            if (
              !service.getBotGroupTaskBlockReason ||
              (await service.getBotGroupTaskBlockReason({
                taskId: alias.taskId,
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
              }))
            ) {
              return [createOutbound(actor, "原话题任务仍在执行，请结束后重新接入话题。")];
            }
          }
        }
        message = { ...message, actor };
      }
// 专用话题群的根事件可能缺失 thread_id。若该群 chatMode==="topic" 且当前
// 事件没有话题，必须交给 provider.resolveTopic 用原生消息反查归属话题，
// 再改写 actor（threadId/rootMessageId）后继续。
// [失败路径] 若直接落到默认任务：根消息一个任务、话题内一个任务，
// 用户看到同一群两个并行任务且互相覆盖，属于数据串线。
      if (message.actor.chatType === "group" && !message.groupCardAction) {
        const parent = (await repo.readState()).bots[
          getBotConversationKey({
            ...message.actor,
            threadId: undefined,
            conversationThreadId: undefined,
          })
        ];
        // 专用话题群根事件可能缺失 thread_id，必须通过原生消息解析，不能进入默认任务。
        if (
          parent?.group?.enabled &&
          parent.group.chatMode === "topic" &&
          !message.actor.threadId
        ) {
// resolveTopic 只有声明该能力的 provider 才可用。缺失时抛错而不是降级：
// 降级的后果是静默进入默认任务，比一次显式失败更难定位，
// 也违反"话题必须绑定任务"的会话身份契约。
          const bot = findBot(await repo.readConfig(), message.botId);
          const resolve = bot && providers[bot.provider]?.resolveTopic;
          if (!bot || !resolve) throw new Error("Topic routing is unavailable");
          message = {
            ...message,
            actor: { ...message.actor, ...(await resolve(bot, message.actor)) },
          };
        }
      }
// 「@ 了别人」的群消息历史上被当成新指令执行过（曾触发停止或 CLI admission）。
// 现在的语义：不触发停止、不做 admission，只推进补读边界，
// 使后续话题历史同步不会把它重复当作未读输入回放。
      if (
        message.actor.chatType === "group" &&
        !message.groupCardAction &&
        !message.elicitationResponse &&
        message.mentionedBot === false &&
        message.contentParts?.some((part) => part.type === "channelMention")
      ) {
        // 已接入话题曾把发给别人的任务也当成新指令；只记录补读边界，不触发停止或 CLI admission。
// 只有话题内需要推进边界：群根消息没有历史游标可对齐，直接丢弃。
// [并发] INV-02：必须经 serializeStateWrite 串行读改写；
// 并发消息各自基于旧 checkpoint 写回会互相覆盖，补读位置倒退或跳跃，
// 表现为历史消息重复注入或漏读。
        if (message.actor.threadId)
          await serializeStateWrite(async () => {
            const state = await repo.readState();
            const current = state.bots[getBotConversationKey(message.actor)];
// 写入前重新读一次当前状态并校验：await 期间话题可能已被 /leave 或禁用。
// 此时不应再为它建立补读边界，否则会给已退出的会话留下脏 revision，
// 下次重新接入时按该 revision 判"历史已同步"，丢掉中间的输入。
            if (!current?.group?.enabled || current.group.topicActive !== true) return;
            const accepted = Object.values(current.group.inputs ?? {}).filter(
              (input) => input.admission === "accepted",
            );
// revision 用随机 UUID 而不是时间戳：它只表达"边界发生过变化"。
// 时间戳在同毫秒并发或时钟回拨时会相等，下游按 revision 去重就会漏判，
// 出现"边界已变但消费者认为没变"。
            current.group.backgroundHistory = {
              revision: randomUUID(),
              checkpoint: current.group.backgroundHistory
                ? current.group.backgroundHistory.checkpoint
                : accepted.at(-1)?.source.messageId,
            };
            await repo.writeState(state);
          });
        return [];
      }
// [权衡] 机器人生成的 slash/审批文本一律降级为 message：命令解析发生在文本层，
// 若不拦，机器人转发一条 "approve" 就能替用户批准（INV-01）。
// 这里改的是解析结果而不是 message.text，保证正文仍可作为输入材料消费。
      // 机器人生成的 slash/审批文字只能作为输入材料，不能进入控制分支。
      const commandType =
        message.senderType === "app"
          ? "message"
          : parseBotCommand(message.commandText ?? message.text).type;
// isGroupControl 决定这条群消息能否插队串行队列：停止/取消类必须绕过排队，
// 否则任务正在执行时用户无法叫停。判定只认命令类型与结构化 elicitation 响应，
// 不认自由文本，防止用自然语言伪装成控制指令抢占输入序列。
      const isGroupControl =
        message.actor.chatType === "group" &&
        (Boolean(message.elicitationResponse) ||
          [
            "queue.cancel",
            "stop",
            "topic.leave",
            "permission.respond",
            "approve",
            "deny",
            "elicitation.respond",
            "elicitation.submit",
          ].includes(commandType));
// [并发] processInbound 被 enqueueInboundProcessing 串行调用，也可能被
// 话题通道直接调用；去重与幂等键在上层 admission 完成，这里不做。
// 因此闭包必须保持"可重入 + 无跨消息共享可变状态"，
// 任何写进闭包外变量的中间结果都会被并发消息交叉污染。
      const processInbound = async () => {
// 私有会话上下文令牌必须在任何回复之前捕获：回复正文可能依赖它构造深链。
// 顺序反了（先构造回复）会拿到上一轮令牌，用户点开链接会落到旧上下文。
        await capturePrivateContextToken(message);
// 结构化 elicitation 响应优先于文本命令：它携带轮次标识，能精确定位 pending 交互。
// 若让它继续走文本解析，"1" 可能被解释成菜单序号而不是本轮选项 id（INV-11）。
        if (message.elicitationResponse) {
          return handleStructuredElicitationResponse(message, message.elicitationResponse);
        }
// 二次解析是必要的：外层 commandType 只用于群控制分类，
// 这里要拿到完整命令对象（commandId/requestId/value/name）。
        const parsedCommand = parseBotCommand(message.commandText ?? message.text);
        // 群主聊天也会进入此分发器；仅改外层 commandType 不能阻止机器人触发控制/数字选择。
// [权衡] 数字选择与 pending selection 的消解只在 message 分支做：
// 先把纯数字映射到上一次菜单选项，映射不到才退回原始文本。
// 这样"用户想输入 1 但菜单已过期"会作为任务正文，而不是错误地改配置；
// 反过来先改配置再判会留下一次无法撤销的副作用。
        const command =
          message.senderType === "app"
            ? ({ type: "message", text: message.text } as const)
            : parsedCommand.type === "message"
              ? (resolvePendingSelectionCommand(message.actor, parsedCommand.text) ?? parsedCommand)
// 微信的 "0" 语义是"取消选择"而非第 0 个选项，需单独澄清：
// 清掉 pending selection 后按普通消息继续，避免用户被永久卡在菜单里，
// 也避免 "0" 被当成非法选项反复报错。
              : parsedCommand.type === "selection.cancel" &&
                  message.actor.provider !== "weixin" &&
                  (message.commandText ?? message.text).trim() === "0"
                ? (clearPendingSelection(message.actor),
                  { type: "message", text: message.text } as const)
                : parsedCommand;
// 首次激活检查必须早于 switch：微信引导回复要短路整条命令链。
// 放进 switch 里就会先执行一次命令副作用（例如 /new 建草稿）再补发引导，
// 用户看到的顺序与真实状态变化不一致。
        const weixinActivationReply = await handleWeixinFirstActivation(message, command);
        if (weixinActivationReply) {
          await capturePrivateContextToken(message);
          return weixinActivationReply;
        }
// [失败路径] 每个 case 自带鉴权（withAuthorizedContext）与任务阻塞检查，
// 分支通常只返回 replies；仅 topic runtime 能力缺失才显式抛错，由上层呈现为失败。
// 集中鉴权反而是漏洞源：新增 case 很容易忘记调用 withAuthorizedContext，所以改为每个 case 自带。
        switch (command.type) {
// 取消群输入队列条目：只动本层 admission 记录（外部协作态），
// 不触碰 CLI 的 accepted 队列——那是 conversation 事实的唯一所有者。
          case "queue.cancel":
            return cancelGroupInput(message, command.commandId);
// 群启用/禁用属于授权面变更：owner 校验在 handleGroupActivation 内部完成，
// 这里只做命令分发，避免两处判断口径分叉。
          case "group.enable":
            return handleGroupActivation(message, true);
          case "group.disable":
            return handleGroupActivation(message, false);
          case "group.history":
            return handleGroupHistory(message, command.enabled);
// 取消菜单：清 pending selection 并回状态卡，不产生任何任务副作用；
// 因此不需要 activeTask 与阻塞检查。
          case "selection.cancel":
            return handleSelectionCancel(message);
// bind 等账号级命令不进入任务上下文：绑定前读不到 context，
// 若先鉴权会直接失败，用户永远无法完成绑定。
          case "bind":
            return handleBind(message, command.code);
          case "help":
            return handleHelp(message);
          case "status":
            return handleStatus(message);
          case "reconnect":
            return handleReconnect(message);
// /new 只改 draft：先鉴权 → 判断话题 → 判断阻塞 → 写 draft context。
// 话题内禁止 /new：一个话题固定绑定一个任务，会话身份不可变；
// 允许的话同一话题会出现两个任务的结果交替写入。
          case "new": {
            const auth = await withAuthorizedContext(message, "new");
            if (!auth.ok) return auth.reply;
            if (message.actor.threadId)
              return [
                createOutbound(
                  message.actor,
                  auth.locale === "en-US"
                    ? "Open another topic to start a new task."
                    : "请另开一个话题开始新任务。",
                ),
              ];
// 阻塞检查必须在写 draft 之前：先写再判会把用户当前有效的任务上下文清掉，
// 即使随后回复了错误，损伤也已经发生。
// 这是 INV-02 的通用要求——先校验、后写入，失败路径不得留下中间态。
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
// 写 draft 而非直接建任务：/new 只重置上下文，真正创建任务发生在首条消息；
// 否则用户 /new 后放弃会留下一堆空任务。
            const context = await writeDraftContext(
              auth.context,
              await buildActiveTaskDraftOptions(auth.context),
            );
            return createStatusReply(message.actor, context, auth.locale);
          }
// /workspace 列表：任务运行中直接拒绝，避免用户误以为可以切换上下文。
// 选项必须保留完整 workspace（含 workspaceIdentity），供点击阶段反查，
// 因为按钮通道只会回传序号，身份信息无法从序号重建。
          case "workspace.list": {
            const auth = await withAuthorizedContext(message, "workspace");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              // Bugfix: task 运行中不展示 workspace 选择，避免用户误以为可以切换上下文。
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
// 先同步配置再过滤：同步会补齐内置/远端候选并回写缺失项，
// 过滤必须在其后，否则 allowlist 会按过期候选集判断。
            const synced = await normalizeBotWorkspaceConfig(
              auth.config,
              auth.bot,
              createCurrentWorkspaceRef(auth.context),
            );
            const visibleWorkspaces = filterAllowedWorkspaces(
              synced.workspaces,
              synced.user.allowedWorkspaces,
            );
            const options = visibleWorkspaces.map((workspace) => ({
              id: workspace.id,
              // Bugfix: Telegram/飞书等按钮通道只展示 label，不展示 description。
              // 远端标识必须合进 label，避免 /workspace 列表看不出哪些项目来自远端。
              label: formatWorkspaceOptionLabel(workspace, auth.locale),
            }));
// [资源] 选项为空时先清掉 pending 记录再回复：残留映射会让后续
// /workspace <n> 解析到已不可见的工作区；
// 清理顺序必须是"先删后回"，否则用户在删除完成前点击会命中旧表。
            if (options.length === 0) {
              pendingWorkspaceSelectionsByContext.delete(getActorContextKey(message.actor));
              return [createOutbound(message.actor, msg(auth.locale, "workspaceMissing"))];
            }
            // Bugfix: 远端 workspace 选项必须在展示时保留 workspaceIdentity。
            // Telegram/飞书按钮会把点击变成 /workspace 序号，切换阶段若重新从 settings 解析，
            // current remote context 可能不在候选列表里，最终表现成 /workspace 不支持远端。
// [并发] pending 选择态只存内存 Map，按 actor context key 隔离，不入 repo：
// 它只是"渲染 → 点击"之间的短生命周期映射，服务重启后旧卡片本就不应可点。
// 若持久化，重启后会用上一进程的选项去解析点击，等价于跨轮次的重放（INV-11）。
            pendingWorkspaceSelectionsByContext.set(
              getActorContextKey(message.actor),
              new Map(visibleWorkspaces.map((workspace) => [workspace.id, { workspace }])),
            );
// 选择卡 id 带时间戳：同一上下文连续两次 /workspace 需要两个可区分的卡片，
// 复用一个 id 会让旧卡片的消息更新覆盖新卡片。
            return createSelectionReply(
              message.actor,
              {
                id: `workspace-${Date.now()}`,
                title: msg(auth.locale, "workspaceSelectTitle", {
                  workspace:
                    visibleWorkspaces.find((workspace) => workspace.id === auth.context.workspaceId)
                      ?.label ?? auth.context.workspacePath,
                }),
                currentId: auth.context.workspaceId,
                action: "workspace.set",
                options,
              },
              auth.locale,
            );
          }
// 切换工作区：优先从 pending 映射取（保留远端 identity），
// 其次才按值在 synced 列表解析。两条路径都必须过 allowlist 校验，
// 因为 pending 表里的条目也可能在渲染后被配置收紧。
          case "workspace.set": {
            const auth = await withAuthorizedContext(message, "workspace");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
// 与列表分支相同，先同步再解析：切换时也要拿到含远端 identity 的最新候选。
            const synced = await normalizeBotWorkspaceConfig(
              auth.config,
              auth.bot,
              createCurrentWorkspaceRef(auth.context),
            );
// 解析顺序固定为 pending 优先、按值次之：pending 里保存的是渲染时的
// 完整 workspace（含远端 identity），按值解析只能拿到同步列表里的引用。
            const workspace =
              resolvePendingWorkspaceSelectionEntry(message.actor, command.value)?.workspace ??
              resolveWorkspaceByValue(
                synced.workspaces,
                command.value,
                synced.user.allowedWorkspaces,
              );
            if (!workspace)
              return [createOutbound(message.actor, msg(auth.locale, "workspaceMissing"))];
            if (!isWorkspaceAllowed(workspace.id, synced.user.allowedWorkspaces))
              return [createOutbound(message.actor, msg(auth.locale, "workspaceOutOfScope"))];
// bindProject 会重建任务级绑定，因此必须基于最新 context 合并后写 draft options；
// 不重建会让新工作区沿用旧模型/旧模式 options，出现"工作区切了但配置还是上一个项目的"。
            const context = { ...auth.context, ...(await bindProject(workspace)) };
            const draftContext = await writeDraftContext(
              context,
              await buildInitializedDraftOptions(context),
            );
// 成功后清理 pending：同一份映射不能跨命令复用，
// 否则下一次 /workspace 会用上一轮的工作区集合解析序号。
            pendingWorkspaceSelectionsByContext.delete(getActorContextKey(message.actor));
            return createStatusReply(message.actor, draftContext, auth.locale);
          }
// /model 分两段取值：draft（无 activeTask）读 draft options，
// active 读运行中任务的 configOptions。两者来源不同不能合并，
// 合并的后果是运行中任务显示的是草稿态模型。
          case "model.list": {
            const auth = await withAuthorizedContext(message, "model");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              // Bugfix: task 运行中不展示模型选择，避免产生运行中不可用的 pending selection。
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
// [权衡] draft 分支不写任何状态：只把候选渲染成选择卡，
// 真正落盘发生在 model.set。反过来"看列表即生效"会让浏览行为产生副作用，
// 用户无法在不改变配置的前提下查看可选模型。
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await resolveDraftOptionsForDisplay(auth.context);
              const providers = await listModelProviderOptionsForActiveTask(
                {
                  model: formatBotModelSelectionValue(draftOptions.modelSelection),
                  workspacePath: auth.context.workspacePath,
                  workspaceIdentity: auth.context.workspaceIdentity,
                },
                draftOptions.provider,
              );
// 无 provider 候选时直接报错：空菜单会让用户点击后必然失败，
// 不如给一条明确的"provider 未配置"提示。
              if (providers.length === 0) {
                return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
              }
              const currentProviderId = await readCurrentModelProviderId(
                {
                  model: formatBotModelSelectionValue(draftOptions.modelSelection),
                  workspacePath: auth.context.workspacePath,
                  workspaceIdentity: auth.context.workspaceIdentity,
                },
                [],
                draftOptions.provider,
              );
              return createSelectionReply(
                message.actor,
                {
                  id: `model-${Date.now()}`,
                  title: msg(auth.locale, "modelProviderSelectTitle", {
                    model: await formatStatusModelLabel(
                      formatBotModelSelectionValue(draftOptions.modelSelection),
                      auth.context,
                    ),
                  }),
                  currentId: currentProviderId,
                  action: "model.provider.set",
                  options: providers,
                },
                auth.locale,
              );
            }
// requireActiveTask 同时校验 activeTaskId 与 task 可读性；
// 返回失败即回执，避免在 task 已消失时继续读 configOptions。
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
            if (!activeProvider) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const providers = await listModelProviderOptionsForActiveTask(
              active.task,
              activeProvider,
            );
            if (providers.length === 0) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const currentValue = readCurrentActiveTaskModel(active.task, active.configOptions);
            const currentProviderId = await readCurrentModelProviderId(
              active.task,
              active.configOptions,
              activeProvider,
            );
            return createSelectionReply(
              message.actor,
              {
                id: `model-${Date.now()}`,
                title: msg(auth.locale, "modelProviderSelectTitle", {
                  model: await formatStatusModelLabel(currentValue, active.task),
                }),
                currentId: currentProviderId,
                action: "model.provider.set",
                options: providers,
              },
              auth.locale,
            );
          }
// 选择 provider 后立刻进入"选模型"第二级：provider → models 是链式交互，
// 中间态通过 pending selection 传递，而不是回写 context。
// 中途放弃时不会留下半套配置。
          case "model.provider.set": {
            const auth = await withAuthorizedContext(message, "model");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await resolveDraftOptionsForDisplay(auth.context);
// draft 分支同样不写状态：只渲染第二级候选，
// 落盘统一在 model.set，保持"浏览无副作用"的一致约定。
              const draftTask = {
                model: formatBotModelSelectionValue(draftOptions.modelSelection),
                workspacePath: auth.context.workspacePath,
                workspaceIdentity: auth.context.workspaceIdentity,
              };
              const providers = await listModelProviderOptionsForActiveTask(
                draftTask,
                draftOptions.provider,
              );
              const provider =
                resolvePendingSelectionOption(message.actor, "model.provider.set", command.value) ??
                resolveOptionByValue(providers, command.value);
              const providerId = provider?.id;
              if (!providerId) {
                return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
              }
// [权衡] provider 自带 models 时直接复用，避免再发一次远端探测；
// 只有列表缺失才回退到运行时查询。远端探测可能超时，
// 放在用户点击的同步路径上会明显拉长回执延迟（也更容易触发 INV-05 的未连接错误）。
              const providerModels = readModelProviderSelectionModels(provider);
              const options =
                providerModels.length > 0
                  ? providerModels
                  : await listModelOptionsForProviderFromActiveTask(
                      draftTask,
                      draftOptions.provider,
                      providerId,
                    );
              if (options.length === 0) {
                return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
              }
              return createSelectionReply(
                message.actor,
                {
                  id: `model-${Date.now()}`,
                  title: msg(auth.locale, "modelModelSelectTitle", {
                    model: formatBotModelSelectionValue(draftOptions.modelSelection) ?? "-",
                  }),
                  currentId: options.some(
                    (option) =>
                      option.id === formatBotModelSelectionValue(draftOptions.modelSelection),
                  )
                    ? formatBotModelSelectionValue(draftOptions.modelSelection)
                    : undefined,
                  action: "model.set",
                  options,
                },
                auth.locale,
              );
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
            if (!activeProvider) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const providers = await listModelProviderOptionsForActiveTask(
              active.task,
              activeProvider,
            );
// 与 draft 分支相同：pending 优先、按值次之，
// 但 active 分支的候选来自运行中 task 的 configOptions。
            const provider =
              resolvePendingSelectionOption(message.actor, "model.provider.set", command.value) ??
              resolveOptionByValue(providers, command.value);
            const providerId = provider?.id;
            if (!providerId) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const providerModels = readModelProviderSelectionModels(provider);
            const options =
              providerModels.length > 0
                ? providerModels
                : await listModelOptionsForProviderFromActiveTask(
                    active.task,
                    activeProvider,
                    providerId,
                  );
            if (options.length === 0) {
              return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            }
            const currentValue = readCurrentActiveTaskModel(active.task, active.configOptions);
            return createSelectionReply(
              message.actor,
              {
                id: `model-${Date.now()}`,
                title: msg(auth.locale, "modelModelSelectTitle", {
                  model: currentValue ?? "-",
                }),
// currentId 只在候选存在时设置：指向已消失的模型会让卡片高亮一个
// 用户点不开的选项。
                currentId: options.some((option) => option.id === currentValue)
                  ? currentValue
                  : undefined,
                action: "model.set",
                options,
              },
              auth.locale,
            );
          }
// 落盘选模。draft 写 draftOptions；active 走 runtime 的 setModel 再广播配置。
// [事务] 顺序固定为「先写状态/调服务，成功后再广播」：先广播会让其它端
// 基于旧值渲染一次，随后被真实回包覆盖，出现可见闪烁与误导性错误提示。
          case "model.set": {
            const auth = await withAuthorizedContext(message, "model");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await ensureDraftOptions(auth.context);
              const model =
                resolvePendingSelectionOption(message.actor, "model.set", command.value) ??
// ensureDraftOptions 会补齐缺失字段再返回：直接读 context 可能在
// 首次使用时拿到 undefined，导致后续 writeDraftOptions 覆盖默认值。
                resolveOptionByValue(
                  await listAllModelOptionsForActiveTask(
                    {
                      model: formatBotModelSelectionValue(draftOptions.modelSelection),
                      workspacePath: auth.context.workspacePath,
                      workspaceIdentity: auth.context.workspaceIdentity,
                    },
                    draftOptions.provider,
                  ),
                  command.value,
                );
              if (!model) {
                return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
              }
// model.id 必须能反解成 {providerId, modelId}（INV-08）。
// 反解失败说明菜单已过期（选项来自旧版本编解码），此时宁可报 modelMissing，
// 也不能静默回退到默认 provider——那等于改写用户的显式选择。
              const identity = parseBotModelOptionValue(model.id);
              const view = await readModelSelectionView(auth.context);
              const selection =
                view && identity ? completeNewModelSelection(view, identity) : undefined;
              // Bot 的主动选模也须取目标最高档；旧菜单失效/读取失败不能清掉已保存选择。
              if (!selection)
                return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
// 写回 draftOptions 时整体替换 modelSelection：模型身份变了，
// 旧的 options（含 reasoningLevel 等）不再适用，必须重新推导。
              const nextContext = await writeDraftOptions(auth.context, {
                ...draftOptions,
                // 模型身份切换必须构造全新的 Selection，不能把旧模型的显式 options 带过去。
                modelSelection: selection,
              });
              return createStatusReply(message.actor, nextContext, auth.locale);
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
            if (!activeProvider) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const model =
              resolvePendingSelectionOption(message.actor, "model.set", command.value) ??
              resolveOptionByValue(
                await listAllModelOptionsForActiveTask(active.task, activeProvider),
                command.value,
              );
            if (!model) return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            const nextModel = model.id;
// custom provider 的选项 id 编码了原始 provider，需先解码再还原运行时模型名。
// 直接透传会在同名模型（如 glm/native）上落回默认实现（INV-08）。
            const customModel = decodeCustomModelValue(nextModel);
            const targetModel = customModel
              ? resolveCustomModelRuntimeModelId(activeProvider, customModel)
              : nextModel;
            if (!targetModel) {
              return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            }
            const targetIdentity = customModel?.modelName
              ? {
                  // Bugfix: bot /model 选择 custom provider 时，targetModel 会被降成纯模型名。
                  // legacy task facade 必须额外拿到原始 provider 身份，否则同名模型会退回 glm/native。
                  providerId: customModel.providerId,
                  modelId: customModel.modelName,
                }
              : { providerId: activeProvider, modelId: targetModel };
// 重新读取 selection view 再构造目标 Selection：view 是当前 provider 的
// 能力快照，用它补全 options 才能保证新模型的目标档位可得。
// 读取失败即视为无法构造，宁可拒绝也不猜档位。
            const view = await readModelSelectionView(active.task);
            const targetModelSelection = view
              ? completeNewModelSelection(view, targetIdentity)
              : undefined;
            if (!targetModelSelection)
              return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
// traceId 绑定 taskId：一次用户可见的选模对应一条可关联追踪链，
// 便于把 bot 侧点击与 runtime 侧模型切换对齐；不绑定的 trace 无法归因。
            const traceId = generateTraceId(active.taskId);
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(active.task);
            const configOptions = await zcodeTaskService.setModel({
              taskId: active.taskId,
              traceId,
              modelSelection: targetModelSelection,
            });
// [并发] 广播在 setModel 成功之后，且 task meta 重新读取：
// 用旧 meta 广播会把重启前的 task 信息带给订阅者。
            await broadcastTaskConfigSync({
              context: auth.context,
              taskId: active.taskId,
              task: await readContextActiveTaskMeta(auth.context),
              provider: activeProvider,
              configOptions,
            });
            return createStatusReply(message.actor, auth.context, auth.locale);
          }
// mode 与 thoughtLevel 共用一份实现：差异只在 commandName 与当前值读取函数。
// 合并可保证两者的选项排序、空列表兜底与标题口径完全一致；
// 拆开写最容易出现"一个走 msg(locale)、另一个硬编码"，所以 mode 与 thoughtLevel 共用一份实现。
          case "mode.list":
          case "thoughtLevel.list": {
            const commandName = command.type === "mode.list" ? "mode" : "thoughtLevel";
            const auth = await withAuthorizedContext(message, commandName);
            if (!auth.ok) return auth.reply;
// bot 私聊硬锁 yolo：不提供模式选择，直接拒绝而不是隐藏选项。
// 隐藏会让用户以为支持而反复尝试；显式拒绝给出确定性结论。
            if (command.type === "mode.list" && !auth.context.group) {
              // Bot 硬锁 yolo：不提供模式选择。
              return [createOutbound(message.actor, msg(auth.locale, "modeLocked"))];
            }
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              // Bugfix: task 运行中不展示模式/思考级别选择，避免和正在执行的上下文配置混淆。
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
// 运行中不做配置切换：mode 变化会改变正在执行会话的语义，
// 与 task 既有的 configOptions 冲突，只能对新任务生效。
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await ensureDraftOptions(auth.context);
              const optionSource = await listDraftConfigOptions(auth.context, draftOptions);
              const rawCurrentValue =
                commandName === "mode"
                  ? draftOptions.mode
                  : findSelectConfigOption(optionSource, commandName)?.currentValue;
              const currentValue =
                typeof rawCurrentValue === "string" ? rawCurrentValue : undefined;
              const currentLabel = readConfigSelectLabelForValue(
                optionSource,
                commandName,
                currentValue,
                { locale: auth.locale, provider: draftOptions.provider },
              );
              const selectOption = findSelectConfigOption(optionSource, commandName);
// 候选与 currentLabel 来自同一 optionSource：
// 保证"当前值"一定出现在候选里，避免卡片显示的值点了却报 missing。
              const options = listConfigSelectOptions(optionSource, commandName, {
                locale: auth.locale,
                provider: draftOptions.provider,
              });
              if (options.length === 0) {
                return [
                  createOutbound(
                    message.actor,
                    msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                  ),
                ];
              }
              return createSelectionReply(
                message.actor,
                {
                  id: `${selectOption?.id ?? commandName}-${Date.now()}`,
                  title:
                    commandName === "mode"
                      ? msg(auth.locale, "modeSelectTitle", {
                          mode: currentLabel ?? "-",
                        })
                      : msg(auth.locale, "thoughtLevelSelectTitle", {
                          level: currentLabel ?? "-",
                        }),
                  currentId: currentValue,
                  action: `${commandName}.set` as SelectionPrompt["action"],
                  options,
                },
                auth.locale,
              );
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
// active 分支的 mode 候选必须从 provider 侧重新拉取：
// 运行中任务的 configOptions 可能落后于 provider 最新能力。
            const optionSource =
              commandName === "mode" && active.task.provider
                ? await listProviderConfigOptionsForActiveTask(
                    active.task,
                    normalizeAgentProviderToZCodeAgent(active.task.provider),
                  )
                : active.configOptions;
            const currentValue =
              commandName === "mode"
                ? readCurrentActiveTaskMode(active.task, active.configOptions)
                : readConfigSelectCurrentValue(active.configOptions, commandName);
            const currentLabel =
              commandName === "mode"
                ? readConfigSelectLabelForValue(optionSource, commandName, currentValue, {
                    locale: auth.locale,
                    provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
                  })
                : readConfigSelectCurrentLabel(active.configOptions, commandName, {
                    locale: auth.locale,
                    provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
                  });
            const selectOption = findSelectConfigOption(optionSource, commandName);
            const options = listConfigSelectOptions(optionSource, commandName, {
              locale: auth.locale,
              provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
            });
            if (options.length === 0) {
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                ),
              ];
            }
            return createSelectionReply(
              message.actor,
              {
                id: `${selectOption?.id ?? commandName}-${Date.now()}`,
                title:
                  commandName === "mode"
                    ? msg(auth.locale, "modeSelectTitle", {
                        mode: currentLabel ?? "-",
                      })
                    : msg(auth.locale, "thoughtLevelSelectTitle", {
                        level: currentLabel ?? "-",
                      }),
                currentId: currentValue,
                action: `${commandName}.set` as SelectionPrompt["action"],
                options,
              },
              auth.locale,
            );
          }
// 真正写入配置。draft 只改本地 options；active 调 setConfigOption 并广播。
// [失败路径] 选项 id 必须能在当前快照里找到，找不到视为菜单过期，
// 返回 missing 文案而不是猜测相近值——猜错等于静默改了用户配置。
          case "mode.set":
          case "thoughtLevel.set": {
            const commandName = command.type === "mode.set" ? "mode" : "thoughtLevel";
            const auth = await withAuthorizedContext(message, commandName);
            if (!auth.ok) return auth.reply;
            if (command.type === "mode.set" && !auth.context.group) {
              // Bot 硬锁 yolo：拒绝任何模式切换请求。
              return [createOutbound(message.actor, msg(auth.locale, "modeLocked"))];
            }
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const originalOptions = await ensureDraftOptions(auth.context);
// [权衡] 先取一次 view 再算 optionSource：候选列表与 currentLabel
// 必须来自同一快照，否则会出现"标题显示 A、选项列表里没有 A"的自相矛盾。
              const view = await readModelSelectionView(
                auth.context,
                originalOptions.modelSelection,
              );
              const optionSource = await listDraftConfigOptions(
                auth.context,
                originalOptions,
                view,
              );
              // 同一个快照给出候选与当前模型；失效原意图不能因副本为空退回 preferred。
              const draftOptions = {
                ...originalOptions,
                modelSelection:
                  (originalOptions.modelSelection
                    ? view?.effectiveSelection
                    : view?.preferredSelection) ?? undefined,
              };
              const displayOptions = listConfigSelectOptions(optionSource, commandName, {
                locale: auth.locale,
                provider: draftOptions.provider,
              });
// pending 优先的原因同前：按钮回传的是序号，只有 pending 表能把它
// 反解成渲染时的选项 id。
              const option =
                resolvePendingSelectionOption(
                  message.actor,
                  `${commandName}.set` as SelectionPrompt["action"],
                  command.value,
                ) ?? resolveOptionByValue(displayOptions, command.value);
// pending 映射命中的选项也必须存在于当前 displayOptions：
// 否则它就是上一轮菜单的残留，直接提交等于用过期 id 改配置。
              if (option && !displayOptions.some((candidate) => candidate.id === option.id)) {
                return [
                  createOutbound(
                    message.actor,
                    msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                  ),
                ];
              }
              if (!option) {
                return [
                  createOutbound(
                    message.actor,
                    msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                  ),
                ];
              }
              const nextContext = await writeDraftOptions(auth.context, {
                ...draftOptions,
                ...(commandName === "mode"
                  ? { mode: option.id }
                  : draftOptions.modelSelection
                    ? {
                        modelSelection: {
                          ...draftOptions.modelSelection,
                          options: {
                            ...draftOptions.modelSelection.options,
                            reasoningLevel: option.id,
                          },
                        },
                      }
                    : {}),
              });
              return createStatusReply(message.actor, nextContext, auth.locale);
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
// active 分支的选项来源与 currentValue 读取函数必须同源，
// 否则会出现"显示的当前档位不在候选列表里"。
            const optionSource =
              commandName === "mode" && active.task.provider
                ? await listProviderConfigOptionsForActiveTask(active.task, active.task.provider)
                : active.configOptions;
            const selectOption = findSelectConfigOption(optionSource, commandName);
            const displayOptions = listConfigSelectOptions(optionSource, commandName, {
              locale: auth.locale,
              provider: active.task.provider,
            });
            const option =
              resolvePendingSelectionOption(
                message.actor,
                `${commandName}.set` as SelectionPrompt["action"],
                command.value,
              ) ?? resolveOptionByValue(displayOptions, command.value);
            if (!option) {
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                ),
              ];
            }
            if (!selectOption?.id) {
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                ),
              ];
            }
// 与选模一致：traceId 绑定 taskId，便于把一次配置点击
// 关联到 runtime 侧的配置变更记录。
            const traceId = generateTraceId(active.taskId);
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const configOptions = await zcodeTaskService.setConfigOption({
              taskId: active.taskId,
              traceId,
              configId: selectOption.id,
              value: option.id,
            });
            await broadcastTaskConfigSync({
              context: auth.context,
              taskId: active.taskId,
              task: await readContextActiveTaskMeta(auth.context),
              provider: active.task.provider,
              configOptions,
            });
            return createStatusReply(message.actor, auth.context, auth.locale);
          }
// /tasks 是只读列表：不需要 activeTask 与阻塞检查，
// 但仍在内部按 owner/bot 过滤可见范围。
          case "task.list":
            return handleTaskList(message);
// 切换任务：话题内禁止（已绑定固定任务），群/私聊需先过阻塞检查。
// [并发] 旧 task 仍有第三方 stream 订阅时不能改写 activeTaskId：
// 输入会落到新 task，而旧 task 的输出仍回到同一 bot 会话，用户看到串线；
// 这正是"运行中的旧 task 必须阻断切换"的原因。
          case "task.set": {
            const auth = await withAuthorizedContext(message, "task");
            if (!auth.ok) return auth.reply;
            if (message.actor.threadId)
              return createStatusReply(message.actor, auth.context, auth.locale);
            const taskEntry = await resolveTaskSelectionEntry(
              message,
              auth.context,
              auth.user,
              command.value,
            );
            if (!taskEntry) return [createOutbound(message.actor, msg(auth.locale, "taskMissing"))];
            const { task } = taskEntry;
// 只有目标与当前 activeTask 不同才做阻塞检查：
// 重复选择同一任务不应被自己的运行态挡住。
            const blockReason =
              auth.context.activeTaskId !== task.taskId
                ? await getContextTaskBlockReason(auth.context)
                : null;
            if (blockReason) {
              // Bugfix: 运行中的旧 task 已经建立了第三方 stream 订阅。
              // 如果此时允许 /task 改写 activeTaskId，后续输入会落到新 task，
              // 但旧 task 输出仍会继续回到同一 bot 会话，用户会误以为消息串线。
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
// [事务] 先写 context，再停旧同步、起新同步：
// 先切换同步目标会有一段窗口期同步器仍指向旧 taskId，
// 期间产生的任务事件会被投影到错误的会话。
            const nextContext = {
              ...auth.context,
              mode: "task",
              activeTaskId: task.taskId,
            } satisfies BotContextState;
            await writeContext(nextContext);
            if (auth.context.activeTaskId !== nextContext.activeTaskId)
              stopGroupSynchronization(auth.context);
            await restoreGroupSynchronization(nextContext);
            pendingTaskSelectionsByContext.delete(getActorContextKey(message.actor));
            return createStatusReply(message.actor, nextContext, auth.locale);
          }
// 回复粒度是 bot 级配置（非任务级），因此无需 activeTask 与阻塞检查；
// 它只影响投递节奏，不影响任务执行。
          case "reply.list": {
            const auth = await withAuthorizedContext(message, "reply");
            if (!auth.ok) return auth.reply;
            return createSelectionReply(
              message.actor,
              {
                id: `reply-${Date.now()}`,
                title: msg(auth.locale, "replySelectTitle", {
                  mode: formatReplyGranularityLabel(
                    auth.bot.replyMode,
                    auth.locale,
                    auth.bot.provider,
                  ),
                }),
                currentId: normalizeBotReplyGranularity(auth.bot.provider, auth.bot.replyMode),
                action: "reply.set",
                options: getReplyGranularityOptions(auth.locale, auth.bot.provider),
              },
              auth.locale,
            );
          }
// reply.set 直接改 bot 配置（saveBot），影响后续所有回复的粒度；
// 因此必须先鉴权到 reply 权限组。
          case "reply.set": {
            const auth = await withAuthorizedContext(message, "reply");
            if (!auth.ok) return auth.reply;
            const replyGranularity = resolveReplyGranularityByValue(
              command.value,
              auth.locale,
              auth.bot.provider,
            );
            if (!replyGranularity)
              return [createOutbound(message.actor, msg(auth.locale, "replyMissing"))];
            await service.saveBot({
              bot: {
                ...auth.bot,
                replyMode: replyGranularity.id,
              },
            });
            return createStatusReply(message.actor, auth.context, auth.locale);
          }
// /leave 语义：关闭话题活跃标记 → 取消本话题未完成输入 → 停止话题执行。
// 顺序不可换：先关标记可阻止新输入在停止过程中被接受，
// 反过来会留下"已离开但仍被受理"的孤儿输入（INV-04）。
          case "topic.leave": {
            const auth = await withAuthorizedContext(message, "workspace");
            if (!auth.ok) return auth.reply;
            if (!auth.context.group?.threadId)
              return [
                createOutbound(
                  message.actor,
                  auth.locale === "en-US"
                    ? "Use /leave inside a topic."
                    : "请在话题中使用 /leave。",
                ),
              ];
            await cancelTopicInputs(message.actor);
// [并发] INV-02：topicActive 必须经 serializeStateWrite 写入，
// 与 channelMention 的补读边界写入串行；否则两者各自 read-modify-write，
// 后写者会把对方的字段覆盖回旧值。
            await serializeStateWrite(async () => {
              const state = await repo.readState();
              const current = state.bots[getBotStateKey(auth.context)];
              if (current?.group) current.group.topicActive = false;
              await repo.writeState(state);
            });
// 仅当确有 activeTask 才读执行句柄：无任务的话题不需要探测 runtime，
// 省一次跨进程调用，也避免在远端未连接时触发请求（INV-05）。
            if (auth.context.activeTaskId) {
              const service = await resolveZCodeTaskServiceForContext(auth.context);
              const target = {
                taskId: auth.context.activeTaskId,
                workspacePath: auth.context.workspacePath,
                workspaceIdentity: auth.context.workspaceIdentity,
              };
              if (!service.readBotTopicExecution || !service.stopBotTopicExecution)
                throw new Error("Topic runtime control is unavailable");
              const executionId = await service.readBotTopicExecution(target);
              if (executionId) await stopTopicRun(auth.context, executionId.executionId);
            }
// 离开话题不停止任务、只停本话题执行：任务仍可在群根继续，
// 这与"退出话题 = 结束任务"的直觉不同，所以文案必须写明可再次 @ 续接。
            return [
              createOutbound(
                message.actor,
                auth.locale === "en-US"
                  ? "Left this topic. Mention me to resume the same task."
                  : "已退出话题。再次 @我可继续原任务。",
              ),
            ];
          }
// /stop：先取消本话题输入，再按"话题/非话题"选择停止方式。
// [失败路径] 停止失败必须把错误文本回给用户且保留任务状态：
// 吞掉错误会让用户以为已停止，实际任务继续执行并持续产生输出。
          case "stop": {
            const auth = await withAuthorizedContext(message, "stop");
            if (!auth.ok) return auth.reply;
            if (auth.context.group?.threadId) await cancelTopicInputs(message.actor);
            if (!auth.context.activeTaskId) {
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            }
// 停止包在 try 里：runtime 可能因远端断连直接抛错（INV-05），
// 此时必须把错误回给用户而不是让整条入站链路失败。
            try {
              const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
              if (auth.context.group?.threadId) {
                if (!zcodeTaskService.readBotTopicExecution)
                  throw new Error("Topic runtime control is unavailable");
                const executionId = await zcodeTaskService.readBotTopicExecution({
                  taskId: auth.context.activeTaskId,
                  workspacePath: auth.context.workspacePath,
                  workspaceIdentity: auth.context.workspaceIdentity,
                });
                if (executionId) await stopTopicRun(auth.context, executionId.executionId);
              } else await zcodeTaskService.stopGeneration({ taskId: auth.context.activeTaskId });
            } catch (error) {
              const messageText = error instanceof Error ? error.message : String(error);
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, "taskFailed", { message: messageText }),
                ),
              ];
            }
// [资源] 停止成功后清运行标记与 typing 定时器，并广播任务列表变更。
// 不清 typingIntervals 会让机器人持续显示"正在输入"直到 provider 侧超时；
// 定时器也是 INV-12 要求 dispose 时必须清理的资源。
            runningTasks.delete(auth.context.activeTaskId);
            stopTyping(auth.context.activeTaskId);
            await broadcastTaskListChange(auth.context, auth.context.activeTaskId, "updated");
            // 群聊成功停止只更新状态，避免状态卡再次触发机器人互答。
            return auth.context.group
              ? []
              : createStatusReply(message.actor, auth.context, auth.locale);
          }
// 数字序号回应权限：序号从 1 开始，非数字/越界都按过期处理。
// [失败路径] 已处理过的选项回 permissionHandled 而不是再次提交：
// IM 按钮可能被重复点击（重试、多人同时点），runtime 侧不保证幂等。
          case "permission.respond": {
            const auth = await withAuthorizedContext(message, "approve");
            if (!auth.ok) return auth.reply;
            if (!auth.context.activeTaskId)
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            const optionIndex = Number.parseInt(command.value, 10) - 1;
            const option = Number.isFinite(optionIndex)
              ? auth.context.pendingPermissionOptions?.[optionIndex]
              : undefined;
// 记录完整判定依据（序号、pending 数量、命中项、是否已处理）：
// 权限问题属于"事后无法复现"的典型，缺少这条日志就无法区分
// "用户点错"与"选项被提前标记为已处理"。
            botsLogger.info(
              undefined,
              `permission callback task=${auth.context.activeTaskId} user=${message.actor.providerUserId} optionIndex=${optionIndex + 1} pending=${auth.context.pendingPermissionOptions?.length ?? 0} option=${option ? `${option.command}:${option.optionId}` : "missing"} handled=${option?.handledAt ? "yes" : "no"}`,
            );
            if (!option)
              return [createOutbound(message.actor, msg(auth.locale, "permissionExpired"))];
            if (option.handledAt)
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const submitted = await zcodeTaskService.respondPermission({
              taskId: auth.context.activeTaskId,
              requestId: option.requestId,
              optionId: option.optionId,
              response: option.response,
            });
            // 修复原因：权限和问答必须以同一个 v4 ACK 为提交点。ACK 失败前不能持久化
            // handledAt，否则 Telegram/文本序号按钮无法重试，runtime 仍会继续等待权限。
// [事务] INV-04：先拿到 respondPermission 的 ACK，再持久化 handledAt。
// 反序会在 ACK 失败时把选项永久标记为已处理：runtime 继续等权限，
// 用户侧重试又被 handledAt 拒绝，accepted 输入失去 terminal 结果。
            const handledAt = Date.now();
            const nextPermissionOptions = auth.context.pendingPermissionOptions?.map((item) =>
              item.requestId === option.requestId ? { ...item, handledAt } : item,
            );
            botsLogger.info(
              undefined,
              `permission callback respond task=${auth.context.activeTaskId} requestId=${option.requestId} optionId=${option.optionId} submitted=${submitted}`,
            );
            if (!submitted) {
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            }
// 只有 submitted 为真才写 handledAt；写入仍经过 writeContext（INV-02），
// 与其它 context 写共用串行通道。
            await writeContext({
              ...auth.context,
              pendingPermissionOptions: nextPermissionOptions,
            });
            await broadcastTaskListChange(
              auth.context,
              auth.context.activeTaskId,
              "permission_resolved",
              {
                requestId: option.requestId,
              },
            );
// 审批通过后重新开始 typing：runtime 会在权限解除后继续推理，
// 不恢复 typing 会让用户以为任务卡住。
            startTyping(auth.bot, message.actor, auth.context.activeTaskId);
            return [
              createOutbound(
                message.actor,
                msg(
                  auth.locale,
                  option.command === "deny" ? "permissionDenied" : "permissionSubmitted",
                ),
              ),
            ];
          }
// 带 token 的结构化 elicitation 回应：轮次与选项 id 由
// handlePendingElicitationValue 校验，这里不做文本层解析。
          case "elicitation.respond": {
            const auth = await withAuthorizedContext(message, "message");
            if (!auth.ok) return auth.reply;
            return handlePendingElicitationValue(auth, message.actor, command.value);
          }
// 微信的"提交"以文本命令进入；非微信通道必须从带 token 的按钮进入，
// 否则无法区分是哪一轮 AskUserQuestion。直接提交可能把上一轮的
// 选择态当作本轮结果，造成跨轮次串答案（INV-11）。
          case "elicitation.submit": {
            const auth = await withAuthorizedContext(message, "message");
            if (!auth.ok) return auth.reply;
            const pending = auth.context.pendingElicitation;
            if (!pending) {
              return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
            }
            if (message.actor.provider !== "weixin") {
              // Bugfix: 非微信通道的“完成”应从带 token 的按钮进入 elicitation.respond。
              // 直接 /elicitation submit 没有轮次标识，可能误提交上一轮 AskUserQuestion。
              return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
            }
            return submitPendingElicitation(
              auth,
              message.actor,
              pending,
              "accept",
              buildBotElicitationContent(pending),
            );
          }
// 按钮式审批：requestId + optionId 直接来自回调，必须与 pending 列表精确匹配。
// 匹配不到视为已处理，不做"按序号猜一个"的兜底——
// 猜测在多人协作群里会批准到别人发起的请求。
          case "approve": {
            const auth = await withAuthorizedContext(message, "approve");
            if (!auth.ok) return auth.reply;
            if (!auth.context.activeTaskId)
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            const pendingOption = auth.context.pendingPermissionOptions?.find(
              (option) =>
                option.requestId === command.requestId && option.optionId === command.optionId,
            );
            if (!pendingOption) {
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            }
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const submitted = await zcodeTaskService.respondPermission({
              taskId: auth.context.activeTaskId,
              requestId: command.requestId,
              optionId: command.optionId,
              response: pendingOption.response,
            });
            if (!submitted)
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            await broadcastTaskListChange(
              auth.context,
              auth.context.activeTaskId,
              "permission_resolved",
              {
                requestId: command.requestId,
              },
            );
            startTyping(auth.bot, message.actor, auth.context.activeTaskId);
            return [createOutbound(message.actor, msg(auth.locale, "permissionSubmitted"))];
          }
// deny 允许在 pending 列表缺失时用默认 deny 响应兜底：拒绝是安全方向，
// 宁可多拒一次也不放行；而 approve 方向不允许同样的兜底。
          case "deny": {
            const auth = await withAuthorizedContext(message, "approve");
            if (!auth.ok) return auth.reply;
            if (!auth.context.activeTaskId)
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            const pendingOption = auth.context.pendingPermissionOptions?.find(
              (option) => option.requestId === command.requestId && option.command === "deny",
            );
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const submitted = await zcodeTaskService.respondPermission({
              taskId: auth.context.activeTaskId,
              requestId: command.requestId,
              optionId: "deny",
              response: pendingOption?.response ?? {
                decision: "deny",
                reason: "Denied by bot command",
              },
            });
            if (!submitted)
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            await broadcastTaskListChange(
              auth.context,
              auth.context.activeTaskId,
              "permission_resolved",
              {
                requestId: command.requestId,
              },
            );
            startTyping(auth.bot, message.actor, auth.context.activeTaskId);
            return [createOutbound(message.actor, msg(auth.locale, "permissionDenied"))];
          }
// 未知命令按当前 locale 渲染；这里重新读 locale 而不复用 auth，
// 因为该分支没有鉴权上下文（无 bot/无 user）。
          case "unknown":
            return [
              createOutbound(
                message.actor,
                msg(await readMessageLocale(), "unknownCommand", {
                  command: command.name,
                }),
              ),
            ];
// 兜底进入消息主流程：所有身份/可见性校验已在前置分支完成，
// handleMessage 内不再重复鉴权，避免两处口径分叉。
          case "message":
            return handleMessage(message);
        }
      };
// [并发] 自动回复回合准入在副作用之前：未通过则整条消息丢弃，
// 不占幂等键、不写状态。若先占键再判，被拒消息会留下投递痕迹，
// 用户重发会被判为重复而永久吞掉（INV-03）。
      if (!(await admitAutoReplyTurn(message))) return [];
// 话题消息走 receiveTopicMessage（会话内续接、保序），其余走串行 admission。
// [权衡] 话题路径独立是必要的：它要保持话题内顺序与续接语义，
// 与群普通消息共用同一队列会互相阻塞，且混淆两种幂等边界。
      const replies =
        message.actor.chatType === "group" && message.actor.threadId && commandType === "message"
          ? await receiveTopicMessage(message)
          : await enqueueInboundProcessing(message.actor, processInbound, isGroupControl);
      if (message.actor.chatType !== "group") return replies;
// [并发] 群回执统一补 thread/root 与 groupCard，必须在 replies 生成之后、
// 返回之前装饰：threadId 可能来自刚刚写入的 group 状态而非入站消息本身。
// 只有带 selection 的回复才卡片化，纯文本回复保持原样，
// 否则每条普通回复都会变成卡片，刷屏且破坏可读性（INV-07 的投递节奏）。
      const current = (await repo.readState()).bots[getBotConversationKey(message.actor)];
      return replies.map((reply) =>
        reply.selection && current?.group?.authorizationId
          ? {
              ...reply,
              threadId: message.actor.threadId ?? current.group.threadId,
              rootMessageId: message.actor.rootMessageId ?? current.group.rootMessageId,
              groupCard: groupCardFor(message.actor, current),
            }
          : reply,
      );
    },
// [入口] provider 回调是外部可控输入：这里只解析并投递，授权在解析出的
// 命令内部完成（INV-01）。payload 不可信，任何身份字段都必须重新校验。
    async handleProviderCallback(provider: BotProvider, payload: unknown) {
      return (await processProviderCallback(provider, payload)).replies;
    },
// 需要向 provider 回写响应体（如飞书 challenge）的调用方走这个入口，
// 语义与 handleProviderCallback 相同，只是把完整结果暴露出来。
    async handleProviderCallbackResponse(provider: BotProvider, payload: unknown) {
      return processProviderCallback(provider, payload);
    },
// [资源] INV-12：同步版本只发起关闭、不等待。
// 错误必须吞掉并记 warn：调用点通常是 Host 退出钩子，
// 未处理的 rejection 会让退出流程本身崩溃，反而阻碍收口。
    disposeAll() {
      void service.disposeAllAndWait().catch((error: unknown) => {
        botsLogger.warn(
          undefined,
          `dispose Bot runtimes failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
// [资源] INV-12：幂等关闭入口。第一个调用者创建 shutdownPromise，
// 后续调用直接复用同一个 Promise，因此下面的清理全局只执行一次。
// 顺序：① 同步失效内存态（阻断新请求进入）→ ② abort 在途 fetch/订阅
//       → ③ 清定时器 → ④ 等 provider runtime 收口。
// 反过来（先 await runtime 再失效内存态）会有新请求在清理期间进入，
// 关闭完成时仍有活跃链路，出现"已 dispose 却仍发请求"。
    disposeAllAndWait() {
      if (shutdownPromise) {
        return shutdownPromise;
      }
// memoryDiagnostics 最先释放：它持有采样计数与定时器，
// 留到最后会让关闭期间的分配继续被记录，产生误导性的内存快照。
      memoryDiagnostics.dispose();
      // 材料下载可能晚于 Host 关闭返回；先同步失效，再回收上传侧的取消代次。
// topicPreparation.clear() 是同步失效：材料下载回调可能晚于 Host 关闭返回，
// 必须先让它们看到"已失效"。若只 await 下载，回调会在等待窗口里
// 继续往已销毁的状态写盘。
      topicPreparation.clear();
// [并发] 先取 key 快照再逐项处理：cancel() 可能触发回调修改同一 Map，
// 直接遍历会在迭代中改变结构，导致漏项或迭代器异常。
      const pendingTopicKeys = [...topicContinuations.keys()];
// topicGenerations 自增就是取消信号：上传侧持有旧代数，代数一变即自我作废。
// 这比逐个 abort 更可靠——下载可能还没创建 AbortController。
      for (const key of pendingTopicKeys) {
        topicGenerations.set(key, (topicGenerations.get(key) ?? 0) + 1);
        topicContinuations.get(key)?.cancel();
// 把所有等待中的话题回复以空数组结算：不结算会让调用方的 await 永久悬挂，
// 表现为 Host 退出时进程不退出。空数组表示"没有回执"，不是失败。
        for (const resolve of topicReplies.get(key)?.values() ?? []) resolve([]);
        topicReplies.get(key)?.clear();
      }
// [资源] 上传侧取消是异步且可能跨进程，因此不阻塞主清理，
// 直接并进最后的 allSettled 一起等待。
      const cancelUploads = (async () => {
        const states = (await repo.readState()).bots;
        await Promise.all(
          pendingTopicKeys.map(async (key) => {
            const context = states[key];
            if (!context?.activeTaskId) return;
            const taskService = await resolveZCodeTaskServiceForContext(context);
            await taskService.invalidateBotTopicInputs?.({
              taskId: context.activeTaskId,
              workspacePath: context.workspacePath,
              workspaceIdentity: context.workspaceIdentity,
            });
          }),
        );
      })();
// [资源] INV-09：流式卡片请求必须 abort。它们是长连接 fetch，
// 只清 Map 不 abort 会留下悬挂连接和未处理的 rejection，
// 关闭后仍可能有迟到响应试图写状态。
      for (const controller of streamingCardRequestControllers) {
        controller.abort(new Error("Bot service disposed."));
      }
      streamingCardRequestControllers.clear();
// 先逐个 dispose 再清表：反序会丢失句柄，事件源无法解绑，
// 后续仍会向已关闭的 service 投递事件。
      for (const subscription of streamSubscriptions.values()) {
        subscription.dispose();
      }
      streamSubscriptions.clear();
      taskStreamHub.dispose();
// 私有恢复定时器必须清理；该句柄已 unref，漏掉不会阻止退出，
// 但会在关闭后每 10s 读一次 state 并可能重建同步器（INV-12）。
      if (privateRecoveryTimer) clearInterval(privateRecoveryTimer);
// 以下全部是"跨消息投影态"：关闭后不再有消费者。
// 逐个 clear 不是为了省内存，而是让关闭后的诊断快照
// 不残留"看起来还在运行"的误导性数据。
      privateImTraces.clear();
      privateWatches.clear();
      failedPrivateDeliveries.clear();
      transientInteractionCards.clear();
      adminAttention.clear();
      for (const intervalId of typingIntervals.values()) {
        clearInterval(intervalId);
      }
      typingIntervals.clear();
      for (const [taskId] of typingTargets) {
        stopTyping(taskId);
      }
      runningTasks.clear();
      liveStatusProgressByTaskId.clear();
      pendingRemoteReconnectsByKey.clear();
      recentRemoteReconnectAtByKey.clear();
      recentRemoteReconnectDeliveryAtByKey.clear();
      recentInboundDeliveryAtByKey.clear();
      automationDeliveryWarningAtByKey.clear();
      inboundProcessingQueuesByContext.clear();
      // Bugfix：host 的异步资源回收会优先调用 disposeAllAndWait。保留统一 Promise，确保并发关闭
      // 只执行一次，并在返回前等三类 Provider runtime 的请求、WebSocket 和跨进程锁全部收口。
// [资源] allSettled 而不是 all：任一 runtime 关闭失败都不能阻止其余两个收口，
// 否则单个 provider 的 bug 会把进程卡在退出阶段。
// 三者分别覆盖请求、WebSocket 与跨进程锁；shutdownPromise 在此定型，
// 因此必须放在所有同步清理完成之后。
      shutdownPromise = Promise.allSettled([
        cancelUploads,
        telegramRuntime.dispose(),
        weixinRuntime.dispose(),
        feishuRuntime.dispose(),
      ]).then(() => undefined);
      return shutdownPromise;
    },
  };
// [并发] 后台任务只在 runStartupBackgroundTasks 为真时启动：
// 测试与嵌入场景不启动定时器，避免"构造 service 就发网络请求"。
  if (runStartupBackgroundTasks) {
    // 远端连接没有 Bot 专属事件源；只检查已存在的连接，不建立额外连接或重放历史。
// 私有会话没有 provider 推送的事件源，只能轮询对账。
// 用 setInterval 而不是常驻长连接，是为了不给远端增加持久连接
// （INV-05 的保守方向：宁可延迟发现，也不制造额外连接）。
    privateRecoveryTimer = setInterval(() => {
// [并发] shutdownPromise 置位后立即停止轮询；
// privateRecoveryPending 是单飞闸门，防止上一轮 readState 未完成时叠加新轮次。
      if (shutdownPromise || privateRecoveryPending) return;
      privateRecoveryPending = true;
      void repo
        .readState()
        .then(async (state) => {
// 只对无私聊群标记的上下文做对账：群会话由群同步器负责，
// 两条路径同时处理同一 botId 会产生重复订阅。
          for (const context of Object.values(state.bots))
            if (!context.group) await reconcilePrivateSynchronization(context.botId);
        })
// [失败路径] 读状态失败只 warn：这是后台对账，
// 一次磁盘抖动不能变成未处理 rejection 打崩进程。
        .catch(() => botsLogger.warn(undefined, "Private Bot recovery state unavailable"))
        .finally(() => {
          privateRecoveryPending = false;
        });
    }, 10_000);
// unref 让该定时器不阻止进程退出：它是后台维护任务，
// 不应成为事件循环常驻的唯一理由。
    privateRecoveryTimer.unref();
// 三个 provider 的 refresh 用 void 发起、不等待：任一通道启动失败
// 都不能阻塞 service 构造（失败在各自内部记日志）。
// 这里的 refresh 只重建已有凭据的连接，不建立 Bot 专属事件源。
    void telegramRuntime.refresh();
    void weixinRuntime.refresh();
    void feishuRuntime.refresh();
// [事务] 存储迁移必须先完成再遍历状态：迁移前的键格式与当前
// BotContextState 不兼容，提前同步会读到错误的工作区/任务绑定，
// 并把错误绑定写回磁盘（迁移随后无法纠正）。
    void ensureBotStorageMigrated()
      .then(async () => {
// 恢复顺序：先重建群同步（有 group 的会话），再对无群会话做私有对账。
// 两类同步器互斥；先群后私可避免同一 botId 被两边同时认领，
// 出现双订阅、双回复。
        for (const context of Object.values((await repo.readState()).bots)) {
          await restoreGroupSynchronization(context);
          if (!context.group) await reconcilePrivateSynchronization(context.botId);
        }
      })
// [失败路径] 初始化失败必须 error 级可见：它影响全局同步能力。
// 但仍只记录不抛出——交互入口各自持有该错误，
// 会在用户下一条消息上暴露，不需要在这里制造未处理 rejection。
      .catch((error: unknown) => {
        // 首次读取失败必须可见，不能产生未处理 rejection；交互入口仍直接收到该错误。
        botsLogger.error(
          undefined,
          `Bot storage initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
  return service;
}
