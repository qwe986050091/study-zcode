import type {
  BotActor,
  BotConfig,
  BotInboundAttachment,
  BotInboundMessage,
  BotOutboundMessage,
  BotProviderCallbackResult,
  Locale,
} from "@zcode/shared";

// 文件不变量表（本文件只声明契约，不执行协议翻译；每条约束由 provider 实现兑现）：
// INV-01：adapter 只做协议翻译与传输，授权/幂等/ownership 判定属于 botsService；
//   这里所有入参都不得承载或暗示权限提升（守住它的位置：BotProviderAdapter 的完整方法签名）。
// INV-02：send 的「成功」以拿到 provider message id 为准；需要回填 id 的消息走
//   BotTransientInteractionCardHandle，返回 void 仅表示该消息无需回填。
// INV-03：入站去重键来自 provider 原生 message id，parseCallback 不得合成 id。
// INV-07：typing/reaction 必须可撤销，因此 startTyping 与 stopTyping 成对声明且均为可选能力。
// INV-11：卡片按钮 value 只作路由，BotProviderCallbackResult 中不存在任何受信任字段。
// [权衡] 所有能力都放在同一个可选方法接口里，而不是按能力拆成多个接口：
// 上层只持有单个 adapter 做能力探测，拆分会让「部分能力可用」退化成多份判空与多次类型收窄。
export interface BotTypingTarget {
  // 接收者在本渠道的稳定用户 ID（飞书 open_id、Telegram chat_id），必填且由上层从可信上下文取。
  providerUserId: string;
  // 可选的锚定消息：飞书 typing reaction 必须挂在某条具体消息上，缺省时实现应静默降级。
  providerMessageId?: string;
  // 渠道自定义上下文票据（如会话线程号），只透传不解析；实现不得据其推断权限。
  providerContextToken?: string;
}

// 下载结果的成对结构：attachment 保留元数据（原始文件名、MIME、声明大小），data 是完整字节。
// [权衡] 这里不做文件名净化也不落盘：净化属于 INV-09 的落盘方，混在类型层会让
// 「谁负责改写远端文件名」变得不可追踪。
// data 不允许 optional 或部分结果：半截字节由调用方丢弃（INV-04），类型上就不给「只拿到一半」的余地。
export interface BotProviderDownloadedAttachment {
  attachment: BotInboundAttachment;
  data: Uint8Array;
}

// 流式回复卡的一块内容：message 是正文片段，tools 是工具调用摘要。
// 用判别联合而非「宽对象 + 全可选字段」：渲染方必须按 type 选择排版，
// 联合类型能让漏处理分支在编译期报错，可选字段只能靠运行时 if 兜底。
export type BotStreamingReplyCardBlock =
  | {
      type: "message";
      text: string;
    }
  | {
      type: "tools";
      summaries: string[];
      title?: string;
      // 摘要区是否默认展开；缺省交给渲染端决定，adapter 不猜用户偏好。
      expanded?: boolean;
    };

// 流式卡片状态是「完整期望态」而不是增量：每次 update 都传全量，
// provider 侧重算整卡，因此同一 state 重放不会产生重复内容（天然幂等）。
// status 生命周期：createStreamingReplyCard 时通常为 running；
// sealed 表示本轮正文已冻结但仍可被后续 update 覆盖；completed/error 为终态。
// blocks 必须先由上层按元素预算（180/200）裁剪，本层不再二次截断，避免两处口径打架（INV-06）。
export interface BotStreamingReplyCardState {
  providerUserId: string;
  locale?: Locale;
  blocks: BotStreamingReplyCardBlock[];
  status: "running" | "sealed" | "completed" | "error";
}

// 卡片句柄只带 providerMessageId，不缓存 token 或卡片实体。
// 这个 id 是后续 update/delete 的唯一凭据；创建时拿不到 id 就必须返回 null 而不是编造（INV-02）。
export interface BotStreamingReplyCardHandle {
  providerMessageId: string;
}

// 瞬时交互卡与流式卡共享同一句柄语义：都是「一条可被反复更新、且可能被删除的消息」。
// [权衡] 用类型别名而不是独立 interface：字段完全一致，独立声明会迫使同时接受两者的调用方
// 写两套重载签名，且将来加字段时要同步改两处。
export type BotTransientInteractionCardHandle = BotStreamingReplyCardHandle;

// ACK 结果：handled 省略等价于 false（本次未处理），由上层决定是否继续走普通消息流程。
// 之所以 acknowledgeCallback 允许返回 void，是因为部分渠道的回调没有可判定的处理结果。
export interface BotProviderAcknowledgeResult {
  handled?: boolean;
}

// 渠道适配器契约。所有方法都可能抛错，语义统一为「本次操作失败」：
// adapter 不自行重试（INV-10），重试/回执由上层决定。
// 可选性语义只有两种，且不可互换：
//   1) 方法缺失（undefined）=> 该渠道不支持此能力，上层走降级分支（纯文本/无 typing/无卡片）；
//   2) 方法存在但返回 null => 能力存在、本次尝试失败或不适用，上层可以继续用降级但不应永久关闭能力。
// 反例：把「不支持」实现成「永远返回 null」会让上层误以为可重试而反复试探；
// 把「一次网络抖动」写成删掉方法，会让该会话此后再也不发卡片。
export interface BotProviderAdapter {
  // 读取话题内单条资源消息（文件/图片等）的原始数据，用于补全话题上下文。
  // 必须遵守 signal：话题切换可能随时取消，adapter 不得吞掉 abort 继续下载（否则白耗带宽）。
  // 解析失败直接抛错，不返回部分结构；调用方按「该资源不可用」处理。
  readTopicResourceMessage?(
    bot: BotConfig,
    target: { messageId: string; chatId: string; threadId: string },
    signal?: AbortSignal,
  ): Promise<import("#src/bots/topicResource.js").TopicResourceMessage>;
  // 把 actor 的会话解析成话题坐标：threadId 是会话容器，rootMessageId 是该话题的根消息。
  // 两者都必须返回：rootMessageId 供历史去重，threadId 供后续回复定位；缺一个就无法维持话题语义。
  // topicUrl 仅用于展示，不参与任何路由或权限判断。
  resolveTopic?(
    bot: BotConfig,
    actor: BotActor,
  ): Promise<{ threadId: string; rootMessageId: string; topicTitle: string; topicUrl?: string }>;
  // 拉取一页话题历史。request 携带条数限制与游标，batch 返回 hasMore/nextCursor；
  // adapter 只做「一页一次请求」，翻页循环留给调用方，避免在适配层引入无界请求（INV-10）。
  readTopicHistory?(
    bot: BotConfig,
    request: import("@zcode/shared").BotTopicHistoryRequest,
  ): Promise<import("@zcode/shared").BotTopicHistoryBatch>;
  // 群成员 open_id -> 展示名 的映射，用于把 mention 渲染成可读名字。
  // 返回 Record 而非数组：调用方按 ID 查表，天然去重；实现通常带缓存，所以不承诺实时性。
  getGroupMemberNames?(bot: BotConfig, chatId: string): Promise<Record<string, string>>;
  // 群基本信息。chatMode 区分普通群与话题群：话题群下每条回复都必须带 threadId。
  // name 只用于展示；查不到名称时应返回空串，不应抛错导致整条发送链路失败。
  getGroupInfo?(
    bot: BotConfig,
    chatId: string,
  ): Promise<{ name: string; chatMode?: "group" | "topic" }>;
  // 连通性自检：ok=false 时 message 必须是人类可读的原因（凭证失效/权限不足/网络不可达）。
  // 约定不抛错：凭证错误是预期结果，抛错会让上层把它当成程序缺陷而不是配置问题（INV-08）。
  test(bot: BotConfig): Promise<{ ok: boolean; message: string }>;
  // 解析 bot 自身在该渠道的显示名，用于系统提示与消息前缀。
  // 返回 null 表示渠道不提供该信息（不是失败），上层不得据此判定 bot 不可用。
  resolveName?(bot: BotConfig): Promise<string | null>;
  // 把命令菜单同步到渠道（如 Telegram setMyCommands）。无返回值是刻意的：
  // 这是尽力而为的辅助行为，失败不应阻断收发，诊断由实现自己记录（INV-10）。
  syncCommands?(bot: BotConfig): Promise<void>;
  // 出站发送的唯一入口，成功语义见 INV-02：
  //   返回 handle => 该消息需要后续 update/delete，providerMessageId 必须真实有效；
  //   返回 void   => 该消息不需要回填 id（普通文本/媒体）。
  // [并发] 同一 bot 的 send 由上层串行调用；adapter 不得依赖跨次调用的顺序维护状态。
  send(
    bot: BotConfig,
    message: BotOutboundMessage,
  ): Promise<void | BotTransientInteractionCardHandle>;
  // 更新群输入 reaction（waiting/working/done/failed/cancelled），必须可撤销且幂等（INV-07）：
  // 同一 messageId 重复设置同一状态不得产生第二条 reaction，也不得抛错。
  // 状态收敛（禁止从终态回退）由 groupInputReaction 的 updater 负责，adapter 只负责「设为该状态」。
  updateInputReaction?(
    bot: BotConfig,
    messageId: string,
    state: import("#src/bots/providers/groupInputReaction.js").GroupInputReaction,
  ): Promise<void>;
  // 一次性 typing 提示（发出即消失），用于不支持持续 typing 的渠道。
  // 与 startTyping/stopTyping 互斥使用：已有 start/stop 的渠道不要再实现 sendTyping，
  // 否则上层会同时走两条路径，产生重复提示。
  sendTyping?(bot: BotConfig, target: BotTypingTarget): Promise<void>;
  // 持续 typing 的开启端。start 失败不应抛出，调用方据此判定「该渠道 typing 不可用」即可。
  // [资源] start 申请的 typing ticket 或刷新定时器必须在 stopTyping 释放，否则会持续占用配额。
  startTyping?(bot: BotConfig, target: BotTypingTarget): Promise<void>;
  // 持续 typing 的关闭端，必须幂等（INV-07）：未 start、重复 stop、start 抛错后 stop 都不得失败；
  // provider 不支持时静默降级为 no-op，不得把「无法撤销」暴露给上层。
  stopTyping?(bot: BotConfig, target: BotTypingTarget): Promise<void>;
  // 解析消息发送者的展示名（用户或机器人）。返回 null 表示查不到，调用方回退到 ID 展示。
  // 这不是发送前置条件：查名失败不能让消息被丢弃。
  resolveActorDisplayName?(bot: BotConfig, actor: BotActor): Promise<string | null>;
  // 回调 ACK：text 是同步回给用户的短文本，message 是需要完整投递的出站消息。
  // payload 是渠道原始回调体，只读；adapter 不得依据其中的按钮 value 做权限判断（INV-11）。
  // signal 用于上层取消（用户撤回/超时）；abort 后不得再发起新的网络请求。
  acknowledgeCallback?(
    bot: BotConfig,
    payload: unknown,
    text?: string,
    message?: BotOutboundMessage,
    signal?: AbortSignal,
  ): Promise<BotProviderAcknowledgeResult | void>;
  // 创建流式回复卡。返回 null 表示渠道不支持或本次创建失败，上层降级为普通文本。
  // 刻意不抛错：卡片是增强能力，创建失败不应让整轮回答失败（INV-06）。
  // 首次创建即写入完整 blocks，避免首帧空白导致用户看到「正在输入」后长时间无内容。
  createStreamingReplyCard?(
    bot: BotConfig,
    state: BotStreamingReplyCardState,
    signal?: AbortSignal,
  ): Promise<BotStreamingReplyCardHandle | null>;
  // 覆盖式更新卡片：每次传完整 state，provider 重算整卡，可安全重放。
  // [并发] 节流由上层完成，adapter 不再加锁；但同一 handle 的多次 update 必须按调用顺序抵达 provider，
  // 乱序会让旧状态覆盖新状态。
  // 抛错表示本次更新失败，上层可继续展示旧卡片，不需要删除重建。
  updateStreamingReplyCard?(
    bot: BotConfig,
    handle: BotStreamingReplyCardHandle,
    state: BotStreamingReplyCardState,
    signal?: AbortSignal,
  ): Promise<void>;
  // 把超预算的一份状态切成多份，供渠道用多张卡片承载（INV-06 的降级路径之一）。
  // 必须是纯函数：只依赖入参，同样的输入得到同样的切分，便于上层重试与测试。
  // 方法缺失意味着上层只有单卡路径，超预算时只能退化为纯文本。
  splitStreamingReplyCardStates?(state: BotStreamingReplyCardState): BotStreamingReplyCardState[];
  // 创建瞬时交互卡（权限确认、计划审批等一次性交互）。返回 null 同 createStreamingReplyCard：上层降级。
  // 与流式卡的关键差异是生命周期短且需要显式 delete，因此句柄可复用但调用方必须保证最终删除。
  createTransientInteractionCard?(
    bot: BotConfig,
    message: BotOutboundMessage,
  ): Promise<BotTransientInteractionCardHandle | null>;
  // 用新的 message 覆盖卡片内容（按钮状态更新、把已点击项置灰）。
  // 必须幂等：同一 message 重放不得产生视觉重复或第二条消息。
  updateTransientInteractionCard?(
    bot: BotConfig,
    handle: BotTransientInteractionCardHandle,
    message: BotOutboundMessage,
  ): Promise<void>;
  // 删除卡片，必须幂等（与 INV-07 同源的撤销语义）：卡片已被用户删除或本就不存在时不得抛错。
  // [资源] 删除成功后 handle 失效，调用方不得再 update，否则会得到一个 provider 侧 404。
  deleteTransientInteractionCard?(
    bot: BotConfig,
    handle: BotTransientInteractionCardHandle,
  ): Promise<void>;
  // 回调预处理：把渠道特有形状（加密体、form 编码、被序列化成字符串的嵌套 JSON）归一化。
  // 校验逻辑（INV-05 的签名/encrypt key/verification token）必须在这里完成并抛错；
  // 绝不能校验失败后仍原样返回 payload，否则 parseCallback 会解析出「看起来合法」的消息并执行业务。
  prepareCallbackPayload?(bot: BotConfig, payload: unknown): Promise<unknown>;
  // 生成同步 HTTP 响应：responseBody 与 status 会直接回给渠道。
  // 返回 null 表示本渠道不需要同步响应，调用方使用默认成功响应。
  // status 必须是渠道要求的成功码（飞书为 200）；返回 4xx/5xx 会被渠道视为投递失败并重推。
  handleCallbackResponse?(
    bot: BotConfig,
    payload: unknown,
  ): Promise<Pick<BotProviderCallbackResult, "responseBody" | "status"> | null>;
  // 下载入站附件。actor 用于判定该用户是否有权读取此附件，signal 支持中途取消。
  // 返回 null 表示附件不可下载（过期/已删除/无权限），调用方应丢弃该附件而不是重试。
  // [失败路径] 实现必须校验 HTTP 状态、大小上限与超时，任一项不满足即丢弃整块（INV-04），
  // 不允许把已读到的半截 data 返回给上层。
  downloadAttachment?(
    bot: BotConfig,
    attachment: BotInboundAttachment,
    actor?: BotActor,
    signal?: AbortSignal,
  ): Promise<BotProviderDownloadedAttachment | null>;
  // 把原始回调 payload 解析成统一入站消息数组。纯函数是硬要求：
  // 不发网络请求、不读写模块级可变状态，便于上层重复解析与单测覆盖。
  // 返回空数组表示「该回调不产生用户消息」（已读回执、已单独处理的卡片交互）。
  // [失败路径] 无法识别形状时返回空数组而非抛错：抛错会让渠道持续重推同一条坏回调，形成死循环。
  parseCallback(payload: unknown): BotInboundMessage[];
}
