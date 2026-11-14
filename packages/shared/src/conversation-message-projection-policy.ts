// INV-01 五档策略互斥且完备，同一条消息只会落到一个桶；守住位置：getConversationMessageProjectionPolicy 的全部分支；改错故障：同一消息在两处渲染或彻底消失
// INV-02 分层判定按固定优先级短路，语义层先于可见性与文本兜底；守住位置：函数内条件分支的书写顺序；改错故障：低优先级标记抢占正文，用户看到重复条目
// INV-03 压缩摘要与 info.summary 一律归上下文，永不进入可见时间线；守住位置：compact_summary 分支；改错故障：摘要伪装成用户消息占据会话历史
// INV-04 真实用户输入要求来源真实、非合成且可见性不是 model-only；守住位置：real_user 分支；改错故障：合成的系统回执被当成用户原话
// INV-05 正常 assistant 正文必须先于 providerVisibility 归入可见助手；守住位置：assistant_response 分支；改错故障：晚订阅的冷恢复丢失模型正文，只剩空壳条目
// INV-07 model-only 可见性或任一 model-only part 一律归上下文；守住位置：可见性检查与 hasModelOnlyPart；改错故障：内部上下文出现在用户时间线
// INV-08 时间线事件、fork 通知与 fork 会话内容一律归时间线；守住位置：isTimelineOnlyMessage 与 FORK_SOURCE 分支；改错故障：分叉快照被当作真实对话回放
// INV-09 source 命中合成白名单时归上下文，不得进入时间线；守住位置：白名单查表；改错故障：后台任务通知丢失，模型失去唤醒上下文
// INV-10 legacy 目标续跑、目标状态与 rewind 文本按上下文处理；守住位置：hasLegacySystemReminderContextText；改错故障：无 source 的旧会话在时间线里冒出内部提示
// INV-11 synthetic 仅在携带任务或子代理通知前缀时保留为上下文；守住位置：synthetic 与通知文本判定的合取；改错故障：无正文的合成通知占据时间线条目
// INV-12 其余 synthetic 归隐藏合成，不展示也不进上下文；守住位置：hiddenSynthetic 兜底；改错故障：内部占位气泡出现在用户界面
// INV-13 全部规则未命中时按角色兜底，助手可见、其余视为真实输入；守住位置：函数末尾的三元返回；改错故障：未知新类型被误删或误显
// INV-14 全函数只读入参，不修改 message、info、parts 与 metadata；守住位置：所有局部解构与查询函数；改错故障：上游消息对象被污染，重放结果漂移 [并发]
// INV-15 parts 缺省视为空数组，所有遍历必须容忍空值；守住位置：parts 解构与各调用点；改错故障：缺 parts 的消息抛异常，整条时间线渲染中断
// INV-16 model-only turn 触发源限定在白名单内且策略必须为上下文；守住位置：getConversationModelOnlyTurnTriggerSource；改错故障：冷恢复跳过 carrier 并生成临时 turn 身份 [并发]
// INV-17 无 source 的旧通知文本回退为 background_task；守住位置：该函数的 legacy 回退分支；改错故障：升级后历史任务不再自动续跑
// INV-18 三个布尔谓词与策略函数同源，不得各自重写判定；守住位置：isConversation 系列包装；改错故障：UI 与运行时对同一条消息给出相反结论
// INV-19 未知 kind、type 与 source 保守保留在可见侧，不主动丢弃；守住位置：各默认分支；改错故障：新协议字段导致用户历史整段消失
//
// 本文件是会话消息投影的唯一判据：只回答一条消息该被谁看见，不负责渲染与存储。
// 五档结果分别对应真实输入、可见助手、仅上下文、仅时间线、隐藏合成，调用方按需消费。
// 判定是纯函数，改动前先确认优先级顺序，再确认 legacy 文本兜底不会被新规则遮蔽。
export type ConversationMessageProjectionPolicy =
  | "realUserInput"
  | "visibleAssistant"
  | "providerContextOnly"
  | "timelineOnly"
  | "hiddenSynthetic";

// 投影入口只承诺只读视图：info 与 parts 都可选，调用方不得依赖字段齐全
// 字段顺序无业务含义，判定只按名字查找，不要按位置或存在性推断消息类型
// 这里是纯函数契约，任何缓存与状态都应留在调用方，不得挂到消息对象上 [并发]
export interface ConversationProjectionMessage {
  info: {
    metadata?: unknown;
    role?: string;
    semantics?: ConversationProjectionMessageSemantics;
    source?: string;
    summary?: unknown;
    synthetic?: boolean;
    visibility?: string;
  };
  parts?: readonly ConversationProjectionPart[];
}

// 语义层的五个维度分别回答：是什么、谁产生、给谁看、进哪条链路
// kind 决定结构类别，origin 决定来源，三路 visibility 决定不同消费者的可见性
// 三者冲突时按函数内的固定顺序取舍，不要在此类型里塞入默认值
export interface ConversationProjectionMessageSemantics {
  kind?: string;
  origin?: string;
  providerVisibility?: string;
  source?: string;
  transcriptVisibility?: string;
  uiVisibility?: string;
}

// part 级标记是消息级信息缺失时的补证：ignored 丢弃、synthetic 合成、timelineType 归类
// metadata 保持 unknown，读取方统一走 metadataRecord 收窄，禁止在此强转 [权衡]
// summaryMessageId 与 timelineType 同时出现时说明这是压缩产物，归时间线而非正文
export interface ConversationProjectionPart {
  ignored?: boolean;
  metadata?: unknown;
  summaryMessageId?: string;
  synthetic?: boolean;
  text?: string;
  timelineType?: string;
  type?: string;
}

// 字符串常量集中在此，避免同一个可见性字面量在判定侧与写入侧各写一遍
// model-only 表示仅供 provider 消费，用户时间线与外部订阅者都看不到 [权衡]
// 紧邻的 fork、目标续跑、任务通知前缀同属 legacy 兜底的匹配素材，改动需同步校验
const MODEL_ONLY_VISIBILITY = "model-only";
const FORK_SOURCE = "fork";
const GOAL_CONTINUATION_REMINDER_PREFIX = '<system-reminder source="goal-continuation">';
const GOAL_CONTINUATION_TEXT_MARKER = "Continue working toward the active session goal.";
const GOAL_STATE_TEXT_MARKER = "Current session goal state";
const TASK_NOTIFICATION_PREFIX = "<task-notification>";
const SUBAGENT_NOTIFICATION_PREFIX = "<subagent-notification>";
const REWIND_NOTICE_MARKERS = ["Conversation rewind applied.", "Workspace rewind applied."];

// 白名单里的 source 表示该消息必须进入 provider 上下文但不能进入可见时间线
// 集合只增不减会放大静默丢弃面，新增条目必须同时确认可见侧不依赖它 [权衡]
// 查表用 has 而非遍历，判定复杂度恒定，且天然去重 [资源]
const PROVIDER_CONTEXT_SYNTHETIC_SOURCES = new Set([
  "agent_listing_delta",
  "agent_control_message",
  "background_task",
  "goal-continuation",
  "goal_completion_verification",
  "goal_state_change",
  "plugin_reference",
  "bot_topic_context",
  "queued_system_notification",
  "resume_goal_state",
  "resume_referenced_session_context",
  "rewind",
  "selection_side_chat",
  "subagent",
  "subagent_message",
  "target_continuation",
  "task_notification",
  "task_status",
  "todo_reminder",
]);

// 只有这些 source 的 carrier 才允许启动独立的 model-only turn，其余一律不触发
// 集合与上下文合成白名单有意不相等，后者更宽前者更严，合并会让边界失控
const MODEL_ONLY_TURN_TRIGGER_SOURCES = new Set([
  "background_task",
  "task_notification",
  "subagent",
  "subagent_message",
  "goal-continuation",
  "target_continuation",
]);

// 这是会话渲染与上下文拼装的唯一判据，所有消费者只读它的返回值
// 判定顺序即优先级：语义层、可见性、时间线、source、文本兜底、角色兜底
// 函数不抛异常也不写状态，未知输入也必须落到某一档而不是抛错 [失败路径]
export function getConversationMessageProjectionPolicy(
  message: ConversationProjectionMessage,
): ConversationMessageProjectionPolicy {
  // 局部解构只是读取别名，不改写入参；parts 缺省成空数组保证后续遍历安全 [并发]
  // semantics 单独取出供语义层多次短路复用，避免同一属性反复访问
  const info = message.info;
  const parts = message.parts ?? [];
  const semantics = info.semantics;

  // 压缩摘要先于一切判定，因为它既含助手正文又含用户提示，不能拆开处理
  // info.summary 存在即视为摘要，即使 kind 缺失也要守住这条更宽的条件
  // 归为上下文后模型仍有完整上下文，用户侧不会看到摘要气泡 [权衡]
  if (semantics?.kind === "compact_summary" || info.summary !== undefined) {
    return "providerContextOnly";
  }

  if (semantics) {
    if (semantics.kind === "timeline_event") {
      return "timelineOnly";
    }
    if (
      // 三个条件同时成立才算真实用户输入：来源真实、非合成、可见性不是 model-only
      // 任一条件不满足就继续向下走，而不是在此直接判成隐藏，交给后续兜底
      semantics.origin === "real_user" &&
      info.synthetic !== true &&
      info.visibility !== MODEL_ONLY_VISIBILITY
    ) {
      return "realUserInput";
    }
    if (
      // 助手正文优先于 providerVisibility 判定，四条件分别是角色、类别与两路可见性
      // 若让 providerVisibility 抢先命中，晚订阅的冷恢复会丢掉正文，只剩空壳条目
      info.role === "assistant" &&
      semantics.kind === "assistant_response" &&
      semantics.uiVisibility === "visible" &&
      semantics.transcriptVisibility === "visible"
    ) {
      // 正常 assistant 同时会进入 provider context 和可见 transcript；
      // providerVisibility 不能抢先把它归成 model-only，否则晚订阅的 cold hydration 会丢正文。
      return "visibleAssistant";
    }
    if (semantics.providerVisibility === "visible") {
      return "providerContextOnly";
    }
    // fork 通知与随后的 agent_runtime、双向 hidden 分支都表示不该出现在会话主视图
    // hidden 判定优先于后续 legacy 文本推断，语义层已给出结论时不再回看正文
    if (semantics.kind === "fork_notice") {
      return "timelineOnly";
    }
    if (
      semantics.origin === "agent_runtime" ||
      semantics.uiVisibility === "hidden" ||
      semantics.transcriptVisibility === "hidden"
    ) {
      return "hiddenSynthetic";
    }
  }

  // 消息级可见性或任一 part 的 model-only 标记都足以把整条消息降为上下文
  // part 级判定只认 visibility 与 goal-continuation 两种来源，不看正文猜测
  if (info.visibility === MODEL_ONLY_VISIBILITY || hasModelOnlyPart(parts)) {
    return "providerContextOnly";
  }

  // 时间线判定覆盖 fork 会话、timeline part 与带状态的压缩 part 三类形态
  // 先判时间线再判 source，避免 fork 内容被通用合成白名单吞成上下文
  if (isTimelineOnlyMessage(info, parts)) {
    return "timelineOnly";
  }

  // source 按 info、info.metadata、semantics、parts 的顺序取首个非空值
  // 取到 fork 即归时间线，命中白名单即归上下文，两者都未命中才继续向下
  const source = messageSource(info, parts);
  if (source === FORK_SOURCE) {
    return "timelineOnly";
  }
  if (source && PROVIDER_CONTEXT_SYNTHETIC_SOURCES.has(source)) {
    return "providerContextOnly";
  }

  // 老数据没有 source，只能靠正文前缀识别目标续跑、目标状态与 rewind 提示
  // 只读取未被 ignored 的 text part 并去掉首部空白，误判面控制在固定前缀内
  if (hasLegacySystemReminderContextText(parts)) {
    return "providerContextOnly";
  }

  if (
    (info.synthetic === true || parts.some((part) => part.synthetic === true)) &&
    hasLegacyNotificationContextText(parts)
  ) {
    return "providerContextOnly";
  }

  // synthetic 只有在带任务或子代理通知前缀时才留作 provider 上下文
  // 其余 synthetic 一律隐藏，这条合取避免把无正文的空壳通知塞进时间线
  if (info.synthetic === true || parts.some((part) => part.synthetic === true)) {
    return "hiddenSynthetic";
  }

  // 全部规则未命中时按角色兜底，保证未知类型被保守展示而不是静默丢弃
  // 新增协议字段若忘记加规则会落到这里，表现为可见但归类稍粗 [权衡]
  return info.role === "assistant" ? "visibleAssistant" : "realUserInput";
}

// 真实用户 turn 起点的定义只在此处，UI 与服务端不得自行比较策略字符串
// 角色为 user 但策略不是 realUserInput 时必须返回 false，避免合成回执启动 turn
export function isConversationRealUserTurnStarter(message: ConversationProjectionMessage): boolean {
  return (
    message.info.role === "user" &&
    getConversationMessageProjectionPolicy(message) === "realUserInput"
  );
}

/**
 * provider-context user carrier 中会真正启动独立 model-only turn 的统一 source policy。
 * live/cold 都必须消费这一个判据，否则冷恢复会跳过 carrier messageId 并生成临时 turn identity。
 */
// live 与冷恢复必须共用这一个触发源判据，否则两侧会生成不同的 turn 身份
// 白名单之外一律返回 null，legacy 通知文本回退为 background_task
export function getConversationModelOnlyTurnTriggerSource(
  message: ConversationProjectionMessage,
): string | null {
  // [失败路径] 角色不是 user 时立即放弃，助手回执与系统占位都不得充当唤醒载体
  if (message.info.role !== "user") return null;
  if (getConversationMessageProjectionPolicy(message) !== "providerContextOnly") {
    return null;
  }
  // [失败路径] 触发源缺失时继续走文本兜底，不因没有 source 就提前返回 null 值
  const source = messageSource(message.info, message.parts ?? []);
  if (source && MODEL_ONLY_TURN_TRIGGER_SOURCES.has(source)) return source;
  // legacy 数据无 source 标记：通知文本前缀仍按既有 background wake 语义恢复。
  if (hasLegacyNotificationContextText(message.parts ?? [])) return "background_task";
  return null;
}

export function isConversationProviderContextOnlyMessage(
  message: ConversationProjectionMessage,
): boolean {
  return getConversationMessageProjectionPolicy(message) === "providerContextOnly";
}

export function isConversationTimelineOnlyMessage(message: ConversationProjectionMessage): boolean {
  return getConversationMessageProjectionPolicy(message) === "timelineOnly";
}

export function isConversationHiddenSyntheticMessage(
  message: ConversationProjectionMessage,
): boolean {
  return getConversationMessageProjectionPolicy(message) === "hiddenSynthetic";
}

function isTimelineOnlyMessage(
  info: ConversationProjectionMessage["info"],
  parts: readonly ConversationProjectionPart[],
): boolean {
  if (info.semantics?.kind === "timeline_event") {
    return true;
  }
  const infoMetadata = metadataRecord(info.metadata);
  if (info.source === FORK_SOURCE || stringValue(infoMetadata?.source) === FORK_SOURCE) {
    return true;
  }
  return parts.some((part) => {
    const metadata = metadataRecord(part.metadata);
    return (
      part.type === "timeline" ||
      hasSessionForkContext(metadata) ||
      (part.type === "compaction" &&
        (typeof metadata?.timelineStatus === "string" || typeof part.summaryMessageId === "string"))
    );
  });
}

function hasModelOnlyPart(parts: readonly ConversationProjectionPart[]): boolean {
  return parts.some((part) => {
    const metadata = metadataRecord(part.metadata);
    return (
      metadata?.visibility === MODEL_ONLY_VISIBILITY ||
      stringValue(metadata?.source) === "goal-continuation"
    );
  });
}

function messageSource(
  info: ConversationProjectionMessage["info"],
  parts: readonly ConversationProjectionPart[],
): string | undefined {
  const infoMetadata = metadataRecord(info.metadata);
  return (
    info.source ??
    stringValue(infoMetadata?.source) ??
    info.semantics?.source ??
    parts
      .map((part) => stringValue(metadataRecord(part.metadata)?.source))
      .find((source): source is string => Boolean(source))
  );
}

function hasLegacySystemReminderContextText(parts: readonly ConversationProjectionPart[]): boolean {
  const text = textFromParts(parts).trimStart();
  return (
    text.startsWith(GOAL_CONTINUATION_REMINDER_PREFIX) ||
    (text.startsWith("<system-reminder>") &&
      (text.includes(GOAL_CONTINUATION_TEXT_MARKER) || text.includes(GOAL_STATE_TEXT_MARKER))) ||
    REWIND_NOTICE_MARKERS.some((marker) => text.includes(marker))
  );
}

function hasLegacyNotificationContextText(parts: readonly ConversationProjectionPart[]): boolean {
  const text = textFromParts(parts).trimStart();
  return text.startsWith(TASK_NOTIFICATION_PREFIX) || text.startsWith(SUBAGENT_NOTIFICATION_PREFIX);
}

function textFromParts(parts: readonly ConversationProjectionPart[]): string {
  return parts
    .filter((part) => part.type === "text" && part.ignored !== true)
    .map((part) => part.text ?? "")
    .join("");
}

function hasSessionForkContext(metadata: unknown): boolean {
  // [权衡] 只认对象形态的 forkContext，数组与标量视为脏数据，宁可漏判也不误吞正文
  const forkContext = metadataRecord(metadata)?.forkContext;
  return (
    typeof forkContext === "object" &&
    forkContext !== null &&
    !Array.isArray(forkContext) &&
    (forkContext as Record<string, unknown>).kind === "session_fork"
  );
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
