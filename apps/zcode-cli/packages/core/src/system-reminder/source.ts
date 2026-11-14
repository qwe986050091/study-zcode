// 系统提醒的投递渠道，决定提醒在会话流中的落点：
// request_prefix 进入请求前缀、current_turn 归入当轮、tool_result 内联到工具结果、
// history_continuity 随历史续接、mid_turn_event 作为轮中事件插入、real_user 由用户消息承载。
export type SystemReminderDeliveryChannel =
  | "request_prefix"
  | "current_turn"
  | "tool_result"
  | "history_continuity"
  | "mid_turn_event"
  | "real_user";

// 系统提醒的生命周期，决定提醒在何时生成与是否可复用：
// request_prefix 每次请求前缀注入、per_current_turn 每轮重建、runtime_local 仅当次运行、
// tool_result 依附工具结果、resume_history 随历史恢复重建、mid_turn_event 轮中事件、real_user 用户消息。
// 与 channel 是两个维度：channel 描述位置，lifecycle 描述生成/存活范围。
export type SystemReminderLifecycle =
  | "request_prefix"
  | "per_current_turn"
  | "runtime_local"
  | "tool_result"
  | "resume_history"
  | "mid_turn_event"
  | "real_user";

// provider 可见性：provider_visible 会真正进入模型上下文；provider_hidden 只用于审计/投影，不投递。
export type SystemReminderProviderVisibility = "provider_visible" | "provider_hidden";

// 请求前缀类来源：每条请求都随前缀重新注入，不持久化到会话历史。
export const SYSTEM_REMINDER_PREFIX_SOURCES = ["context_prefix", "skills_listing"] as const;

// 可持久化来源：产生后会写入会话历史/事件，恢复时按原文重建，因此内容必须稳定可重放。
// 新增来源须同时确认其持久化后的重建方式与缓存前缀影响。
export const SYSTEM_REMINDER_PERSISTED_SOURCES = [
  "tool_search_announcement",
  "agent_listing_delta",
  "todo_reminder",
  "task_status",
  "tool_result_warning",
  "resume_referenced_session_context",
  "plan_file_reference",
  "resume_goal_state",
  "goal_state_change",
  "plugin_reference",
  "bot_topic_context",
  "target_continuation",
  "goal_completion_verification",
  "rewind_notice",
  "conversation_fork",
  "selection_side_chat",
  "queued_system_notification",
  "shell_environment_change",
] as const;

// 每请求来源：不落盘，依据当前运行时状态按请求重新计算；因此可依赖实时数据（时间、内存、诊断）。
export const SYSTEM_REMINDER_PER_REQUEST_SOURCES = [
  "incoming_message",
  "hook_context",
  "memory_update",
  "relevant_memory",
  "runtime_mode",
  "plan_mode_exit",
  "output_style",
  "date_change",
  "referenced_session_context",
  "model_anomaly",
  "prompt_attachment",
  "diagnostics",
] as const;

// 由上面三组常量派生出的字面量联合类型，作为各来源分类在类型层面的收窄入口。
export type SystemReminderPrefixSource = (typeof SYSTEM_REMINDER_PREFIX_SOURCES)[number];
export type SystemReminderPersistedSource = (typeof SYSTEM_REMINDER_PERSISTED_SOURCES)[number];
export type SystemReminderPerRequestSource = (typeof SYSTEM_REMINDER_PER_REQUEST_SOURCES)[number];

// 全部来源的联合类型；新增来源时必须同时登记到上面对应的来源数组，否则描述符表会缺项。
export type SystemReminderSource =
  | SystemReminderPrefixSource
  | SystemReminderPersistedSource
  | SystemReminderPerRequestSource;

// 单个来源的完整元数据描述，供投递、持久化、审计与 UI 投影统一读取，避免各处硬编码判断。
export interface SystemReminderSourceDescriptor {
  // 来源标识，与来源数组中的字面量一一对应。
  source: SystemReminderSource;
  // 在会话流中的落点，决定提醒被插入到前缀、当前轮、工具结果还是历史续接位置。
  channel: SystemReminderDeliveryChannel;
  // 生成与存活范围，决定是否每轮重建、是否随历史恢复重放。
  lifecycle: SystemReminderLifecycle;
  // 是否为系统生成的元信息；true 表示非用户输入，下游据此避免把其当作真实用户确认。
  isMeta: boolean;
  // provider 可见性；非 provider_visible 的来源不允许调用 wrapSystemReminderForSource 投递。
  providerVisibility: SystemReminderProviderVisibility;
  // 审计/证据标签，稳定字符串常量，用于日志与追溯，不面向模型展示。
  evidenceLabel: string;
}

// 描述符表中不含 source 字段的形状；查表时再把 source 拼回去，避免同一 key 写两遍。
type DescriptorShape = Omit<SystemReminderSourceDescriptor, "source">;

// 检测正文是否已含 system-reminder 标签。刻意不加 g 标志：wrapSystemReminder 会重复调用 test，
// 带 g 的正则会保留 lastIndex，导致同一字符串的判定结果随调用次数翻转。
const SYSTEM_REMINDER_TAG_PATTERN = /<\/?system-reminder\b/i;
// 中和嵌套标签用，需要 g 才能替换全部出现位置；每次 replace 都会重置匹配状态，可安全复用。
const SYSTEM_REMINDER_NESTED_TAG_PATTERN = /<\/?system-reminder\b/gi;
// 需要在包裹后额外补尾部换行的来源；目前仅 context_prefix 需要与前缀后续内容隔开。
const SYSTEM_REMINDER_TRAILING_NEWLINE_SOURCES = new Set<SystemReminderSource>(["context_prefix"]);
// 不应按 mid-conversation 位置插入的来源白名单：这些提醒必须保持在对话边界之前/工具结果内。
const NON_MID_CONVERSATION_SYSTEM_SOURCES = new Set<SystemReminderSource>([
  "context_prefix",
  "resume_referenced_session_context",
  // Fork 和辅助对话边界必须位于新问题之前；走 MCS 会被移到问题之后，改变上下文顺序。
  "conversation_fork",
  "selection_side_chat",
  "plan_file_reference",
  "target_continuation",
  "tool_result_warning",
  "goal_completion_verification",
]);

// 来源 → 元数据的映射表。类型为 Record<SystemReminderSource, …>，漏登记任何一个来源都会在编译期报错。
// 表中条目均通过 descriptor() 构造，因此 providerVisibility 目前恒为 provider_visible；
// 需要隐藏来源时须显式改表，不能依赖调用点判断。
// 顺序无业务含义（运行时按 source 直接查表），但新增来源建议贴近同类渠道便于审阅。
const SYSTEM_REMINDER_DESCRIPTORS: Record<SystemReminderSource, DescriptorShape> = {
  tool_search_announcement: descriptor(
    "current_turn",
    "resume_history",
    true,
    "sr.tool_search_announcement",
  ),
  agent_listing_delta: descriptor("current_turn", "resume_history", true, "sr.agent_listing_delta"),
  incoming_message: descriptor("mid_turn_event", "mid_turn_event", true, "sr.incoming_message"),
  bot_topic_context: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.bot_topic_context",
  ),
  context_prefix: descriptor("request_prefix", "request_prefix", true, "sr.context_prefix"),
  skills_listing: descriptor("request_prefix", "request_prefix", true, "sr.skills_listing"),
  hook_context: descriptor("current_turn", "per_current_turn", true, "sr.hook_context"),
  memory_update: descriptor("current_turn", "per_current_turn", true, "sr.memory_update"),
  relevant_memory: descriptor("current_turn", "per_current_turn", true, "sr.relevant_memory"),
  runtime_mode: descriptor("current_turn", "per_current_turn", true, "sr.runtime_mode"),
  plan_mode_exit: descriptor("current_turn", "runtime_local", true, "sr.plan_mode_exit"),
  output_style: descriptor("current_turn", "per_current_turn", true, "sr.output_style"),
  date_change: descriptor("current_turn", "runtime_local", true, "sr.date_change"),
  referenced_session_context: descriptor(
    "current_turn",
    "per_current_turn",
    true,
    "sr.referenced_session_context",
  ),
  // Plugin 对话引用：当轮生成后按
  // model-only synthetic notice 固化，后续只追加、不改写；冷恢复按原文重建以保持缓存前缀。
  plugin_reference: descriptor("current_turn", "per_current_turn", true, "sr.plugin_reference"),
  todo_reminder: descriptor("current_turn", "per_current_turn", true, "sr.todo_reminder"),
  task_status: descriptor("mid_turn_event", "mid_turn_event", true, "sr.task_status"),
  // 只用于 Read 等 tool result 内容内联 warning，不作为 synthetic user notice 持久化。
  tool_result_warning: descriptor("tool_result", "tool_result", true, "sr.tool_result_warning"),
  resume_referenced_session_context: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.resume_referenced_session_context",
  ),
  plan_file_reference: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.plan_file_reference",
  ),
  resume_goal_state: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.resume_goal_state",
  ),
  goal_state_change: descriptor("mid_turn_event", "mid_turn_event", true, "sr.goal_state_change"),
  target_continuation: descriptor("real_user", "real_user", false, "sr.target_continuation"),
  goal_completion_verification: descriptor(
    "tool_result",
    "tool_result",
    true,
    "sr.goal_completion_verification",
  ),
  model_anomaly: descriptor("mid_turn_event", "mid_turn_event", true, "sr.model_anomaly"),
  rewind_notice: descriptor("history_continuity", "resume_history", true, "sr.rewind_notice"),
  conversation_fork: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.conversation_fork",
  ),
  selection_side_chat: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.selection_side_chat",
  ),
  prompt_attachment: descriptor("current_turn", "per_current_turn", true, "sr.prompt_attachment"),
  queued_system_notification: descriptor(
    "mid_turn_event",
    "mid_turn_event",
    true,
    "sr.queued_system_notification",
  ),
  shell_environment_change: descriptor(
    "mid_turn_event",
    "mid_turn_event",
    true,
    "sr.shell_environment_change",
  ),
  diagnostics: descriptor("mid_turn_event", "mid_turn_event", true, "sr.diagnostics"),
  // 第四批 4a-0（2026-09-12）：原 plugin_ui_state 源已删除，插件给模型的信息改走 ui/update-model-context。
};

// 全部来源的汇总列表，顺序为 prefix → persisted → per-request，并冻结以防调用方就地改写。
// 该列表是"来源全集"的唯一事实来源；MID_CONVERSATION_SYSTEM_SOURCES 也由它派生。
export const SYSTEM_REMINDER_SOURCES = Object.freeze([
  ...SYSTEM_REMINDER_PREFIX_SOURCES,
  ...SYSTEM_REMINDER_PERSISTED_SOURCES,
  ...SYSTEM_REMINDER_PER_REQUEST_SOURCES,
]);

// 可按 mid-conversation 位置插入的来源集合，由"全集减去白名单"在模块加载时一次性算出。
// 用补集而非逐个列举，保证新增来源默认允许插入对话中部；只有明确需要固定位置的来源才进白名单。
const MID_CONVERSATION_SYSTEM_SOURCES = new Set<SystemReminderSource>(
  SYSTEM_REMINDER_SOURCES.filter((source) => !NON_MID_CONVERSATION_SYSTEM_SOURCES.has(source)),
);

// 读取来源的完整元数据：返回带 source 字段的新对象，避免调用方改写共享的描述符常量。
// 输入 source 必须属于 SystemReminderSource；越界取值会得到 undefined 字段而非报错。
// 副作用：纯函数，无缓存副作用、无 IO。
export function getSystemReminderDescriptor(
  source: SystemReminderSource,
): SystemReminderSourceDescriptor {
  const descriptor = SYSTEM_REMINDER_DESCRIPTORS[source];
  return {
    source,
    ...descriptor,
  };
}

// 判断来源是否为系统元信息（非真实用户输入）。语义等价于描述符的 isMeta，供调用点免于取整表项。
// 副作用：纯函数。
export function isSystemReminderMetaSource(source: SystemReminderSource): boolean {
  return getSystemReminderDescriptor(source).isMeta;
}

// 判断来源是否允许按 mid-conversation 位置插入；false 表示必须固定在对话边界之前或工具结果内。
// 副作用：纯函数，O(1) 集合查询。
export function isMidConversationSystemSource(source: SystemReminderSource): boolean {
  return MID_CONVERSATION_SYSTEM_SOURCES.has(source);
}

// 按来源包裹 system-reminder 标签，并做来源级后处理，是业务侧投递提醒的统一入口。
// 输入：body 为单个字符串或行数组（数组按 "\n" 拼接）；source 决定描述符与尾随换行规则。
// 输出：形如 <system-reminder>…</system-reminder> 的字符串；context_prefix 会额外追加一个换行。
// 失败：来源不可被 provider 见时抛 Error（调用方应视为编程错误，而非可恢复运行时错误）；
//   正文为空或含嵌套标签时由 wrapSystemReminder 抛错。
// 副作用：纯函数；包裹前先做嵌套标签中和，保证输出结构始终合法。
export function wrapSystemReminderForSource(
  source: SystemReminderSource,
  body: string | readonly string[],
): string {
  const sourceDescriptor = getSystemReminderDescriptor(source);
  if (sourceDescriptor.providerVisibility !== "provider_visible") {
    // 隐藏来源只应进入审计/投影，若被要求投递给模型说明调用链用错了来源，直接失败暴露。
    throw new Error(`System reminder source ${source} is not provider-visible`);
  }
  const wrapped = wrapSystemReminder(sanitizeSystemReminderBody(body));

  return SYSTEM_REMINDER_TRAILING_NEWLINE_SOURCES.has(source) ? `${wrapped}\n` : wrapped;
}

// 给正文加上 system-reminder 首尾标签，不做来源判断，也不做嵌套标签中和。
// 输入：字符串或行数组；数组按 "\n" 拼接。输出：三行结构（开标签/正文/闭标签）。
// 失败：正文为空（含空数组）抛 Error；正文已含 system-reminder 开或闭标签时抛 Error，
//   防止模型看到伪造的提醒边界。两处均为不可静默忽略的契约违反。
// 副作用：纯函数。需要容错时调用方应先走 sanitizeSystemReminderBody。
export function wrapSystemReminder(body: string | readonly string[]): string {
  const content = typeof body === "string" ? body : body.join("\n");
  if (content.length === 0) {
    throw new Error("System reminder body cannot be empty");
  }
  if (SYSTEM_REMINDER_TAG_PATTERN.test(content)) {
    // 使用非 g 正则，保证重复 test 结果稳定；命中即拒绝而不是静默转义，避免嵌套结构歧义。
    throw new Error("System reminder body must not include nested system-reminder tags");
  }
  return ["<system-reminder>", content, "</system-reminder>"].join("\n");
}

// 中和正文中已有的 system-reminder 标签（含大小写与属性变体），使其不再构成有效标签。
// 输入为字符串或行数组；输出总是字符串，不修改其余文本内容。
// 副作用：纯函数；不抛错，因此可用于不可信来源（如工具输出、附件）的预处理。
export function sanitizeSystemReminderBody(body: string | readonly string[]): string {
  return escapeNestedSystemReminderTags(body);
}

// 构造描述符形状的内部工厂，统一填 providerVisibility 默认值。
// 输入：channel、lifecycle、isMeta 与证据标签；输出：不含 source 的描述符片段。
// 副作用：纯函数。默认 provider_visible，隐藏来源需绕开本函数或后续显式覆盖。
function descriptor(
  channel: SystemReminderDeliveryChannel,
  lifecycle: SystemReminderLifecycle,
  isMeta: boolean,
  evidenceLabel: string,
): DescriptorShape {
  return {
    channel,
    lifecycle,
    isMeta,
    providerVisibility: "provider_visible",
    evidenceLabel,
  };
}

// 把正文中所有 system-reminder 标签的起始 "<" 转义为 "&lt;"，标签本身保留原样以便阅读。
// 输入：字符串或行数组（数组按 "\n" 拼接）；输出：转义后的新字符串。
// 只替换起始尖括号而不删除标签，可保留原始文本痕迹，便于排查来源。
function escapeNestedSystemReminderTags(body: string | readonly string[]): string {
  const content = typeof body === "string" ? body : body.join("\n");
  // 与 wrapper 的拒绝规则一致，含空格/大小写变体的关闭标签也只中和起始 <。
  return content.replace(SYSTEM_REMINDER_NESTED_TAG_PATTERN, (tag) => `&lt;${tag.slice(1)}`);
}
