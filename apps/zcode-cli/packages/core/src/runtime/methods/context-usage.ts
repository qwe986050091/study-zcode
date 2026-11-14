// INV-01 [口径] 全部 token 都是本地估算而非 provider 权威计数；守住位置：buildContextUsageSnapshot 返回值的 tokenMethod、confidence、tokenizer 三字段；改错故障：上层把估算当账单或预算依据，压缩阈值与实际用量偏移后无人察觉。
// INV-02 [契约] 分类必须七类互斥且与白名单同源；守住位置：CONTEXT_USAGE_BREAKDOWN_SOURCES 与 buildContextUsageSnapshot 的七个分类调用；改错故障：同一段内容落进两个桶，总量虚高且百分比失真。
// INV-03 [契约] Messages 分类必须排除 system 与 meta_user；守住位置：conversationMessageBreakdown 对 options.messages 的过滤条件；改错故障：system prompt 与 meta user context 被二次累加，总量明显高于真实请求。
// INV-04 [失败路径] task_notification 形态的 meta user 消息要按消息计回；守住位置：过滤条件里 sourceEntries 的 inputPresentation 判断；改错故障：带 wrapper 的新轮通知未进 sections 又被排除，Messages 漏算。
// INV-05 [契约] 分桶时 skills 与 tools 只能各归一类；守住位置：systemSections 与 metaUserSections 对 source 的两处排除；改错故障：技能文本同时计入 System prompt 与 Skills，两个分类都偏高。
// INV-06 [来源] section 指标应复用构建期已算好的 chars 与 tokens；守住位置：systemPromptSections 映射里的 estimatedMetricFromKnown 调用与 medium 置信度；改错故障：改从最终 messages 反推，估算口径与真正拼进 prompt 的文本脱节。
// INV-07 [契约] 工具 schema 估算必须覆盖全部体积相关字段；守住位置：buildToolUsageDetail 里 stringifyForEstimation 的入参清单；改错故障：漏掉输入输出 schema 或权限字段，工具占用被长期低估。
// INV-08 [契约] 工具分类由名字解析结果决定；守住位置：buildToolUsageDetail 中 parseMcpToolName 的返回值分支；改错故障：MCP 工具被记成 system_tool，两个 schema 分类与实际来源不符。
// INV-09 [契约] 技能估算要覆盖元数据而非仅名字；守住位置：buildSkillUsageDetails 里 join 前的字段数组与过滤；改错故障：只算 name 与 description，skill prompt 体积被系统性低估。
// INV-10 [契约] 按 role 聚合时要把 toolCalls 等结构化载荷算进去；守住位置：buildMessageRoleBreakdown 中 stringifyForEstimation 的五个字段；改错故障：tool call 参数不计入，assistant 与 tool 消息的 token 明显偏低。
// INV-11 [单位] chars 与 tokens 必须来自同一份序列化文本；守住位置：estimatedMetric 用 content.length 与 estimateTokens 处理同一个 content；改错故障：两处分别序列化，字符与 token 比例失真，面板无法互校。
// INV-12 [权衡] 过滤 0 token 分类只影响展示总量；守住位置：categories 数组末尾的 filter 条件；改错故障：保留空桶会稀释百分比分母，连明细一起过滤则丢掉该类细节。
// INV-13 [失败路径] 百分比分母必须防零；守住位置：categoriesWithPercent 映射里 totalTokens 大于 0 的三元判断；改错故障：空快照时出现 NaN 或 Infinity，序列化后前端渲染异常。
// INV-14 [权衡] totalTokens 是可归因用量而非 provider 总量；守住位置：buildContextUsageSnapshot 末尾两次 reduce 求和；改错故障：直接与 provider usage 或账单对比，差值被误判为泄漏或漏算。
// INV-15 [失败路径] 持久化快照必须逐字段防御；守住位置：buildContextUsageBreakdownFromSnapshot 的 isRecord 判断与 continue 分支；改错故障：一行坏数据抛出异常，整张消耗面板无法渲染。
// INV-16 [契约] source 必须命中枚举白名单；守住位置：contextUsageBreakdownSource 里的类型判断与 Set 成员检查；改错故障：未知来源被放行，下游出现无法归因的幽灵分类。
// INV-17 [失败路径] 非法 chars 要返回 undefined 而不是 0；守住位置：nonNegativeInteger 对非数值、非有限、负数的短路；改错故障：损坏数据被截断成 0 参与统计，掩盖上游序列化错误。
// INV-18 [资源] 日志快照必须先压缩再落盘；守住位置：logContextUsageSnapshot 里 compactContextUsageSnapshot 的包裹；改错故障：完整明细进入 debug 日志，单条事件体积失控且拖慢日志写入。
//
// 模块职责：把 context sections、工具契约、技能加载结果与消息数组折算成七类互斥的 token 估算，产出分类占比、明细与告警，仅服务日志与调试面板。
// 状态所有权：函数无跨调用状态，输入来自 latestContextBuildResult、options 与 skillLoadOutcome，返回值或日志事件是唯一事实。
// 阅读顺序：先看分类白名单与快照日志入口，再读 buildContextUsageSnapshot 的取数、分桶、过滤与求和，最后看持久化反序列化与各估算助手。
/**
 * ============================================================================
 * runtime/methods/context-usage.ts —— 上下文用量的"估算分解"(诊断用)
 * ============================================================================
 *
 * 【定位】这里产出的 token 数全部是本地估算(estimateTokens),不是 provider 的
 * authoritative count,只用于日志/调试面板:
 *   - 分类口径(system_prompt / meta_user_context / skills / tool_prompt /
 *     system_tool_schemas / mcp_tool_schemas / messages)互斥,避免同一内容被算两次;
 *   - confidence 标出可信度:文本 low、段落 medium、消息 medium;
 *   - 真正决定请求预算的是 model-token-limits + provider usage,不是这里的数字。
 *
 * 【为什么 Messages 分类要排除 system/meta_user】
 * system prompt 与 meta user context 已经按 ContextBuilder sections 单独统计,
 * 若再按 messages 数组逐条累加,同一段内容会被重复计入总量。
 * 唯一例外是 task_notification 形态的 meta user 消息:它带 wrapper 但未进入
 * sections,必须按消息计回,否则会漏算。
 * ============================================================================
 */
import { modelMessageContentToText, traceContextToLogContext, estimateTokens } from "../deps.js";
import type { ModelInputMessage, ModelToolContract, TraceContext } from "../deps.js";
import type { ContextUsageBreakdownItem } from "@zcode/contracts";
import {
  measureUtf8Bytes,
  findLatestUserMessageFromEnd,
  stringifyForEstimation,
  parseMcpToolName,
  isMetaUserContextMessage,
} from "../helpers/index.js";
import {
  buildCategoryBreakdown,
  messageRoleContributor,
  sectionContributor,
  skillContributor,
  toolContributor,
  type ContextUsageCategoryBreakdown,
} from "../helpers/context-usage-breakdown.js";
import { compactContextUsageSnapshot } from "./context-usage-log-compact.js";
import type {
  ActiveTurnSteeringState,
  DrainedPendingInputDiagnostics,
  RunModelTextRequestOptions,
  ContextUsageConfidence,
  ContextUsageMetric,
  ContextUsageCategory,
  ContextUsageToolDetail,
  ContextUsageSkillDetail,
  ContextUsageMessageRoleBreakdown,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

// [契约] ContextUsageBreakdownSource 是 ContextUsageCategory 来源字段的子集，只保留可跨层输出的七类口径。
// [来源] 该联合与下方 CONTEXT_USAGE_BREAKDOWN_SOURCES 白名单、以及 buildContextUsageSnapshot 的七个分类调用必须同源。
// [失败路径] 白名单少写一项，旧 snapshot 里的该类字符会在解析时被静默丢弃，面板只少一行、不报错。
// [权衡] messages 列入白名单是因为它承担字符归因，但它并非 ContextBuilder 的 section 来源。
// [口径] 白名单是持久化反序列化的唯一准入面，字符串比较基于该联合而非自由文本。
type ContextUsageBreakdownSource = ContextUsageCategory["source"];

const CONTEXT_USAGE_BREAKDOWN_SOURCES = new Set<ContextUsageBreakdownSource>([
  "system_prompt",
  "meta_user_context",
  "skills",
  "tool_prompt",
  "system_tool_schemas",
  "mcp_tool_schemas",
  "messages",
]);

// [职责] 该函数只做一次 debug 日志发射，不参与预算计算，也不改变 runtime 状态。
// [权衡] snapshot 作为带默认值的参数惰性构建：调用方已算过时可传入复用，避免重复遍历 messages 与 sections。
// [契约] 默认分支每次调用都会重建快照，热路径上反复调用会放大估算成本。
// [来源] 事件名 context_usage_snapshot、module core.runtime、status completed 是日志检索的稳定锚点。
// [资源] compactContextUsageSnapshot 负责把明细压到可安全落日志的规模，绕过它会让单条日志膨胀。
// [边界] traceContext 平铺在最外层，保证快照日志能按 traceId 关联到同一请求链。
// [失败路径] logger 允许为空，因此这里用可选调用，日志通道缺失不应影响请求主流程。
export function logContextUsageSnapshot(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
  snapshot: Record<string, unknown> = this.buildContextUsageSnapshot(options),
): void {
  // snapshot 默认惰性构建:调用方若已算过(例如要在事件里复用),可以直接传入,
  // 避免同一请求重复遍历 messages/sections 做估算。
  // compactContextUsageSnapshot 负责把明细压缩成"可安全进日志"的规模。
  this.logger?.debug("Context usage snapshot", {
    ...traceContextToLogContext(options.traceContext),
    event: "context_usage_snapshot",
    module: "core.runtime",
    status: "completed",
    ...compactContextUsageSnapshot(snapshot),
  });
}

export function logModelRequestSteeringContext(
  this: AgentRuntimeInternal,
  options: {
    activeTurn?: ActiveTurnSteeringState;
    drained?: DrainedPendingInputDiagnostics;
    messages: ModelInputMessage[];
    modelStepCount: number;
    traceContext: TraceContext;
  },
): void {
  // 没有 steering 状态也没有 drain 诊断时无事可记:该函数只服务诊断日志,
  // 直接早退,避免每个普通请求都产生一条空事件。
  if (!options.activeTurn && !options.drained) return;

  const drainedCount = options.drained?.pendingInputIds.length ?? 0;
  // 用"消息数组末尾连续 N 条都是 user"作为"被 drain 的输入确实拼进了请求尾部"的
  // 廉价校验:不去解析 message 内容,只看 role 分布。这个判断只写进诊断日志,
  // 不参与请求构造,所以允许是启发式的。
  const drainedTail = drainedCount > 0 ? options.messages.slice(-drainedCount) : [];
  const drainedInputVisibleAtTail =
    drainedCount > 0 &&
    drainedTail.length === drainedCount &&
    drainedTail.every((message) => message.role === "user");
  const messageTail = this.buildModelMessageTailDiagnostics(options.messages);

  this.logger?.debug("Model request steering context", {
    ...traceContextToLogContext(options.traceContext),
    activeTurnId: options.activeTurn?.turnId,
    activeTurnKind: options.activeTurn?.kind,
    activeTurnQueueLength: options.activeTurn?.pendingInputs.length,
    activeTurnSteerable: options.activeTurn?.steerable,
    drainedInputCount: drainedCount,
    drainedInputVisibleAtTail,
    drainedPendingInputIds: options.drained?.pendingInputIds,
    event: "model.request.steering_context",
    injectedMessageIds: options.drained?.injectedMessageIds,
    latestUserMessageFromEnd: findLatestUserMessageFromEnd(options.messages),
    messageCount: options.messages.length,
    messageTail,
    messageTailRoles: messageTail.map((message) => message.role),
    modelStepCount: options.modelStepCount,
    module: "core.runtime",
    status: "completed",
  });
}

// [用途] 产出请求尾部至多 limit 条消息的结构化摘要，只服务诊断，不参与请求构造。
// [契约] 默认 limit 为 8，index 用 messages.length 减尾部长度回推，保证与原始数组下标一致。
// [单位] contentBytes 走 UTF-8 字节数而非字符数，用于区分中文与 ASCII 的体积差异。
// [权衡] contentBlockCount 只在 content 为数组时有值，纯文本消息该字段缺省，读取方需容忍 undefined。
// [资源] 摘要只带 role、toolCallId、toolName 与计数，不回灌消息正文，避免日志泄露内容。
export function buildModelMessageTailDiagnostics(
  this: AgentRuntimeInternal,
  messages: ModelInputMessage[],
  limit = 8,
): Array<Record<string, unknown>> {
  const tail = messages.slice(-limit);
  const startIndex = messages.length - tail.length;
  return tail.map((message, index) => ({
    contentBytes: measureUtf8Bytes(modelMessageContentToText(message.content)),
    contentBlockCount: Array.isArray(message.content) ? message.content.length : undefined,
    hasToolCalls: (message.toolCalls?.length ?? 0) > 0,
    index: startIndex + index,
    role: message.role,
    toolCallCount: message.toolCalls?.length ?? 0,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
  }));
}

// [职责] 这是整份估算的唯一聚合点：读 context sections、工具契约、技能加载结果与消息数组，产出分类、明细与告警。
// [来源] sections 取自 latestContextBuildResult，缺失时退化为空数组，此时 System prompt 与 Meta user context 会归零。
// [单位] section 级 chars/tokens 直接用构建期结果并标 medium，属于“真正拼进 prompt 的文本”，优于从消息反推。
// [互斥] 四个分桶按 injectionTarget 与 source 切分：system 排除 skills 与 tools，meta_user 排除 skills，skills 与 tools 各自成类。
// [权衡] messageBreakdown 是按 role 的全量视图，conversationMessageBreakdown 才是 Messages 分类的去重视图，两者不可合并。
// [失败路径] 去重条件里 sourceEntries 可能缺项，用可选链读取 inputPresentation，缺省时按普通 meta user 处理。
// [契约] 七个分类在 tokens 为 0 时被过滤，因此 categories 长度不固定，消费方不能按下标取类。
// [契约] 百分比以可归因总量为分母，totalTokens 为 0 时统一给 0，避免出现 NaN。
// [契约] 返回值固定声明 tokenMethod estimated、confidence low 与 tokenizer 版本，供下游识别口径。
// [权衡] warnings 两条是给面板的人读约束：本地估算非 provider count、Messages 已排除重复来源。
export function buildContextUsageSnapshot(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
): Record<string, unknown> {
  const contextSections = this.latestContextBuildResult?.sections ?? [];
  // section 级指标优先用构建时已经算好的 chars/tokens(medium 置信度):
  // 那是"真正拼进 prompt 的文本",比从最终 messages 反推更接近实际。
  const systemPromptSections = contextSections.map((section) => ({
    name: section.name,
    source: section.source,
    injectionTarget: section.injectionTarget,
    cacheHint: section.cacheHint,
    ...this.estimatedMetricFromKnown(section.chars, section.tokens, "medium"),
  }));
  // 按注入目标 + 来源做互斥分桶:
  //   system      → System prompt(排除 skills/tools,它们另有分类);
  //   meta_user   → Meta user context(同样排除 skills);
  //   skills/tools→ 各自单独成类,不重复计入 system prompt。
  const systemSections = systemPromptSections.filter(
    (section) =>
      section.injectionTarget === "system" &&
      section.source !== "skills" &&
      section.source !== "tools",
  );
  const metaUserSections = systemPromptSections.filter(
    (section) => section.injectionTarget === "meta_user" && section.source !== "skills",
  );
  const skillSections = systemPromptSections.filter((section) => section.source === "skills");
  const toolPromptSections = systemPromptSections.filter((section) => section.source === "tools");
  const toolDetails = options.tools.map((tool) => this.buildToolUsageDetail(tool));
  const systemTools = toolDetails.filter((tool) => tool.source === "system_tool");
  const mcpTools = toolDetails.filter((tool) => tool.source === "mcp_tool");
  const skillDetails = this.buildSkillUsageDetails();
  // messageBreakdown 是"全量按 role"的展示视图(含 system),
  // conversationMessageBreakdown 才是用于 Messages 分类的去重视图。
  // 两者分开是为了让调试面板既能看到完整消息构成,又不影响分类合计。
  const messageBreakdown = this.buildMessageRoleBreakdown(options.messages);
  const conversationMessageBreakdown = this.buildMessageRoleBreakdown(
    options.messages.filter(
      // 根因：新轮通知带 wrapper，但并未计入 ContextBuilder sections；按可信来源计回 Messages，避免漏算。
      // 这行的判据是"消息在 sourceEntries 里声明为 task_notification"——
      // 不能只看 isMetaUserContextMessage,否则所有 meta user 都会被二次计入。
      (message, index) =>
        message.role !== "system" &&
        (!isMetaUserContextMessage(message) ||
          options.sourceEntries?.[index]?.metadata?.inputPresentation === "task_notification"),
    ),
  );
  const nonSystemMessageMetric = this.sumMetrics(conversationMessageBreakdown, "medium");

  const categories = [
    this.buildContextUsageCategory(
      "System prompt",
      "system_prompt",
      this.sumMetrics(systemSections, "medium"),
    ),
    this.buildContextUsageCategory(
      "Meta user context",
      "meta_user_context",
      this.sumMetrics(metaUserSections, "medium"),
    ),
    this.buildContextUsageCategory("Skills", "skills", this.sumMetrics(skillSections, "medium")),
    this.buildContextUsageCategory(
      "Tool prompt",
      "tool_prompt",
      this.sumMetrics(toolPromptSections, "medium"),
    ),
    this.buildContextUsageCategory(
      "System tool schemas",
      "system_tool_schemas",
      this.sumMetrics(systemTools, "low"),
    ),
    this.buildContextUsageCategory(
      "MCP tool schemas",
      "mcp_tool_schemas",
      this.sumMetrics(mcpTools, "low"),
    ),
    this.buildContextUsageCategory("Messages", "messages", nonSystemMessageMetric),
  ].filter((category) => category.tokens > 0);
  // 总量与百分比都只基于"已计入分类"的部分:被过滤掉的 0 token 分类
  // 不再拉低百分比;也意味着 totalTokens 是"可归因用量",不是 provider 的 total。
  const totalTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
  const totalChars = categories.reduce((sum, category) => sum + category.chars, 0);
  const categoriesWithPercent = categories.map((category) => ({
    ...category,
    percentTokens: totalTokens > 0 ? category.tokens / totalTokens : 0,
  }));
  const categoryBySource = new Map(
    categoriesWithPercent.map((category) => [category.source, category]),
  );
  const categoryBreakdown = [
    buildCategoryBreakdown(
      categoryBySource,
      "system_prompt",
      systemSections.map((section) => sectionContributor("system_prompt", section)),
    ),
    buildCategoryBreakdown(
      categoryBySource,
      "meta_user_context",
      metaUserSections.map((section) => sectionContributor("meta_user_context", section)),
    ),
    buildCategoryBreakdown(
      categoryBySource,
      "skills",
      skillDetails.map((skill) => skillContributor("skills", skill)),
    ),
    buildCategoryBreakdown(
      categoryBySource,
      "tool_prompt",
      toolPromptSections.map((section) => sectionContributor("tool_prompt", section)),
    ),
    buildCategoryBreakdown(
      categoryBySource,
      "system_tool_schemas",
      systemTools.map((tool) => toolContributor("system_tool_schemas", tool)),
    ),
    buildCategoryBreakdown(
      categoryBySource,
      "mcp_tool_schemas",
      mcpTools.map((tool) => toolContributor("mcp_tool_schemas", tool)),
    ),
    buildCategoryBreakdown(
      categoryBySource,
      "messages",
      conversationMessageBreakdown.map((message) => messageRoleContributor(message)),
    ),
  ].filter((breakdown): breakdown is ContextUsageCategoryBreakdown => breakdown !== undefined);

  return {
    tokenMethod: "estimated",
    confidence: "low",
    tokenizer: "zcode.estimateTokens.v1",
    totalChars,
    totalTokens,
    model: `${options.model.providerId}/${options.model.modelId}`,
    categories: categoriesWithPercent,
    categoryBreakdown,
    systemPromptSections,
    systemTools,
    mcpTools,
    skills: skillDetails,
    messageBreakdown,
    warnings: [
      "当前 token 来自本地估算，不是 provider count；tool schema 的真实 token 取决于 provider 序列化。",
      "Messages 分类不重复计算 system role 或 meta user context，因为它们已按 sections 单独统计。",
    ],
  };
}

// [边界] 入参是类型为 unknown 的持久化快照，可能来自旧版本或跨进程，全部字段按不可信处理。
// [失败路径] 非对象分类直接 continue，单行坏数据只丢该桶，不让整张面板失败。
// [契约] source 必须命中白名单，chars 必须是非负有限数且大于 0，两者任一不满足即跳过。
// [契约] 输出只保留 source 与 chars，token 明细不跨出本层，便于口径后续演进。
// [权衡] 0 字符桶被丢弃，因为对展示没有价值，也让上层少一次空行渲染。
// [顺序] 先校验 source 再校验 chars，任一失败都不 push，保持输出数组与输入顺序一致。
// [资源] 返回数组长度不超过输入分类数，不做去重合并，重复桶由上游保证不出现。
export function buildContextUsageBreakdownFromSnapshot(
  snapshot: Record<string, unknown>,
): ContextUsageBreakdownItem[] {
  // 输入来自"已持久化/跨进程"的 snapshot(类型是 unknown),
  // 所以逐字段防御:非法 source 忽略、chars 必须是非负有限整数且 > 0。
  // 输出只保留 {source, chars}:上层只需要"哪类内容占了多少字符",
  // token 明细不跨出这一层(口径随时可能变)。
  const categories = Array.isArray(snapshot.categories) ? snapshot.categories : [];
  const breakdown: ContextUsageBreakdownItem[] = [];

  for (const category of categories) {
    if (!isRecord(category)) {
      continue;
    }
    const source = contextUsageBreakdownSource(category.source);
    const chars = nonNegativeInteger(category.chars);
    // 非法 source 或非法 chars 直接跳过而不是报错:snapshot 可能来自旧版本/跨进程,
    // 不能因为一行坏数据让整张面板失败;0 字符也没有展示价值。
    if (!source || chars === undefined || chars <= 0) {
      continue;
    }
    breakdown.push({ source, chars });
  }

  return breakdown;
}

export function buildContextUsageCategory(
  this: AgentRuntimeInternal,
  name: ContextUsageCategory["name"],
  source: ContextUsageCategory["source"],
  metric: ContextUsageMetric,
): ContextUsageCategory {
  return {
    name,
    source,
    ...metric,
    percentTokens: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contextUsageBreakdownSource(value: unknown): ContextUsageBreakdownSource | undefined {
  // 只接受契约枚举内的 source:持久化 snapshot 的类型是 unknown,
  // 未知来源会让下游统计出现无法归因的"幽灵桶"。
  if (typeof value !== "string") {
    return undefined;
  }
  return CONTEXT_USAGE_BREAKDOWN_SOURCES.has(value as ContextUsageBreakdownSource)
    ? (value as ContextUsageBreakdownSource)
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  // NaN/Infinity/负数都视为"没有值"(undefined),不能截断成 0:
  // 0 会被当成合法字符数参与统计,反而掩盖上游数据损坏。
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}

// [来源] 工具 schema 的真实体积由 provider 序列化决定，这里用统一 JSON 形态估算并标 low。
// [契约] 参与估算的字段覆盖描述、能力、输入输出 schema、权限与结果预算，漏项会长期低估工具占用。
// [契约] source 由 parseMcpToolName 的解析结果决定，MCP 工具额外带 serverName。
// [失败路径] 名字不符合 MCP 命名时按 system_tool 归类，宁可归错也不能让工具从面板消失。
// [权衡] 只读与副作用范围同时输出，既服务展示也便于排查“体积大且危险”的工具。
export function buildToolUsageDetail(
  this: AgentRuntimeInternal,
  tool: ModelToolContract,
): ContextUsageToolDetail {
  // 工具 schema 的真实序列化由 provider 负责,这里用统一 JSON 形态做估算,
  // 并把影响体积的字段全部纳入(描述/能力/输入输出 schema/权限/预算),
  // 否则"看起来很小、实际很大"的工具会长期被低估。
  const content = stringifyForEstimation({
    name: tool.name,
    description: tool.description,
    capability: tool.capability,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    sideEffectScope: tool.sideEffectScope,
    permission: tool.permission,
    resultBudget: tool.resultBudget,
  });
  const mcp = parseMcpToolName(tool.name);
  return {
    name: tool.name,
    source: mcp ? "mcp_tool" : "system_tool",
    serverName: mcp?.serverName,
    readOnly: tool.readOnly,
    sideEffectScope: tool.sideEffectScope,
    ...this.estimatedMetric(content, "low"),
  };
}

export function buildSkillUsageDetails(this: AgentRuntimeInternal): ContextUsageSkillDetail[] {
  return (this.skillLoadOutcome?.skills ?? []).map((skill) => {
    const content = [
      skill.name,
      skill.description,
      skill.whenToUse,
      skill.source,
      skill.scope,
      skill.path,
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n");
    return {
      name: skill.name,
      source: skill.source,
      scope: skill.scope,
      path: skill.path,
      ...this.estimatedMetric(content, "medium"),
    };
  });
}

// [职责] 按 role 聚合成 chars、count、tokens 三元组，是 Messages 分类与全量视图的共同底座。
// [契约] 估算载荷包含 role、content、toolCalls、toolCallId 与 toolName，只算 content 会低估 assistant 与 tool 消息。
// [单位] chars 取序列化文本长度，tokens 走 estimateTokens，两者来自同一字符串以保证比例可解释。
// [顺序] 首次遇到的 role 从零值起步再累加，输出顺序即首次出现顺序，不做字典序重排。
// [契约] 结果统一标 medium 置信度，因为输入是结构化消息而非原始 prompt 文本。
// [权衡] 空消息数组返回空数组，调用方求和的 sumMetrics 会得到 0，不会产生占位 role。
export function buildMessageRoleBreakdown(
  this: AgentRuntimeInternal,
  messages: RunModelTextRequestOptions["messages"],
): ContextUsageMessageRoleBreakdown[] {
  // 按 role 聚合时把 toolCalls/toolCallId/toolName 也纳入估算:
  // tool call 的结构化载荷(尤其参数)在 provider 序列化后同样占 token,
  // 只算 content 会系统性低估 assistant/tool 消息。
  const byRole = new Map<string, { chars: number; count: number; tokens: number }>();
  for (const message of messages) {
    const content = stringifyForEstimation({
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
    });
    const current = byRole.get(message.role) ?? { chars: 0, count: 0, tokens: 0 };
    current.chars += content.length;
    current.count += 1;
    current.tokens += estimateTokens(content);
    byRole.set(message.role, current);
  }

  return [...byRole.entries()].map(([role, value]) => ({
    role,
    count: value.count,
    ...this.estimatedMetricFromKnown(value.chars, value.tokens, "medium"),
  }));
}

export function estimatedMetric(
  this: AgentRuntimeInternal,
  content: string,
  confidence: ContextUsageConfidence,
): ContextUsageMetric {
  return this.estimatedMetricFromKnown(content.length, estimateTokens(content), confidence);
}

export function estimatedMetricFromKnown(
  this: AgentRuntimeInternal,
  chars: number,
  tokens: number,
  confidence: ContextUsageConfidence,
): ContextUsageMetric {
  return {
    chars,
    tokens,
    tokenMethod: "estimated",
    confidence,
    tokenizer: "zcode.estimateTokens.v1",
  };
}

export function sumMetrics(
  this: AgentRuntimeInternal,
  values: Array<Pick<ContextUsageMetric, "chars" | "tokens">>,
  confidence: ContextUsageConfidence,
): ContextUsageMetric {
  return {
    chars: values.reduce((sum, value) => sum + value.chars, 0),
    tokens: values.reduce((sum, value) => sum + value.tokens, 0),
    tokenMethod: "estimated",
    confidence,
    tokenizer: "zcode.estimateTokens.v1",
  };
}
