/* eslint-disable max-lines -- 八类 strict telemetry fact 的同源归一集中维护，避免 privacy allowlist 分叉。 */
// 定位：只做“观测事实”的归一，不读写产品态（transcript/snapshot/队列都不在这里改）。
// 输入是 live SessionEvent + 少量 runtime metadata；输出是 strict schema 校验后的 telemetry fact，
// 由上层送往埋点通道。高频事件在这里做聚合/去重：首 chunk 只标一次、completed request 入队配对、
// 工具名按调用缓存；所有辅助表都有界（超 2000 键淘汰最旧），防止长会话内存膨胀。
// 失败口径：无法归一/不该外送的事件返回 null；schema.parse 失败由调用方按观测失败丢弃，
// 不得回滚或阻塞用户轮次。normalize 本身无 IO、无持久化、无广播。
// 职责边界：本文件是 telemetry 事实层的唯一入口，把 live SessionEvent 翻译成 strict fact。
// 它不拥有产品态：不写 transcript、不写 snapshot、不读 projection、不发帧，因而也不能在恢复时补造事实。
// 事实是单向派生：事件流到 fact 再到上层埋点通道；任何从 fact 回写事件或旁路表的路径都会变成双写。
// 八类 kind 共用一条 base 信封，字段名与枚举由 conversationTelemetryFactSchema 收口，本文件不自造字段。
// 下面的不变量按“破坏后最晚在哪一步炸”排列，改动前先确认没有踩到其中任意一条。
// INV-01 断言：本文件只做事件到事实的单向派生，任何 fact 都不得回写 SessionEvent 或产品态 —— 守住它的位置：normalize 全流程只读 event、只写本类旁路表 —— 改错故障：埋点回写会与产品写入双写，恢复场景出现重复轮次。
// INV-02 断言：无法归一或不该外送的事件返回 null，而不是抛错 —— 守住它的位置：各 case 的早退分支与 default —— 改错故障：观测异常冒泡成用户轮次失败，主流程被埋点拖死。
// INV-03 断言：null、0 与缺失是三种语义，缺失必须省略字段，0 必须原样保留 —— 守住它的位置：optionalString 与 nonNegative 的判据 —— 改错故障：把 0 当成缺失会丢真实数据，把缺失写成 0 会伪造用量。
// INV-04 断言：base 信封字段在分派前一次性生成，后续各 case 不得覆盖 —— 守住它的位置：normalize 开头构造 base 的位置 —— 改错故障：越往后改 eventSeq 与 occurredAt，同一事件在不同 kind 下时间线会漂移。
// INV-05 断言：eventSeq 必须是非负整数，occurredAt 必须是非负毫秒 —— 守住它的位置：base 里的取整夹值处理与 eventTimestamp —— 改错故障：负数或 NaN 进入 strict schema，整条事实被丢弃。
// INV-06 断言：首 chunk 只标一次，且子工具流不得被记成主轮首 token —— 守住它的位置：firstStreamChunks.add 与 streamKey 里的 parentToolCallId —— 改错故障：TTFT 统计被首个工具 chunk 抢走，指标整体偏小。
// INV-07 断言：旁路表总量有界，超限只丢关联上下文，不改变是否产事实 —— 守住它的位置：两个 Bounded 结构的容量判断 —— 改错故障：长会话无界增长导致内存泄漏，或为了让字段不丢而把上限改成无限。
// INV-08 断言：LRU 表必须先删后插，写序即淘汰序 —— 守住它的位置：BoundedValueMap.set 的前两行 —— 改错故障：命中不刷新顺序，淘汰掉仍在使用的 toolName 关联。
// INV-09 断言：ModelComplete 与先前 completed request 按 session 与 querySource 配对，先进先出 —— 守住它的位置：completedModelRequests 的追加与出队 —— 改错故障：乱序配错 requestId，用量归到别的请求上。
// INV-10 断言：usage 只外送 main_turn、subagent、workflow_child 与历史无 querySource 的主轮 —— 守住它的位置：isStepUsageQuerySource 的白名单 —— 改错故障：标题 sidecar 的小额 token 被累加进主对话，用户看到用量虚高。
// INV-11 断言：准入等待两端的状态不得进入 model.request.status —— 守住它的位置：ModelNetworkStatus 分支的显式 return null —— 改错故障：枚举外的状态让 schema 校验抛错，整条网络状态事实丢失。
// INV-12 断言：工具终态必须走显式白名单映射，不得透传 perf.detail —— 守住它的位置：toToolPerformanceFact 的字段枚举 —— 改错故障：detail 里的内部字段进 strict schema，整条工具终态被判非法丢弃。
// INV-13 断言：工具名优先取事件显式字段，缓存只做补齐 —— 守住它的位置：explicitName 与 toolNameByCall 的取值顺序 —— 改错故障：缓存旧名覆盖显式新名，重命名后的工具被记成旧工具。
// INV-14 断言：turn 终态必须在事实构造成功后清旁路，且清的是整个 turn 前缀 —— 守住它的位置：TurnComplete 与 TurnError 分支末尾的 clearTurn —— 改错故障：提前清会丢终态关联，只清精确键会残留首 chunk 记录。
// INV-15 断言：会话级清理必须同时清模型缓存与 completed request 队列 —— 守住它的位置：clearSession 里的五处删除 —— 改错故障：切换会话后旧请求队列被复用，用量配到新会话。
// INV-16 断言：automation 触发信息只在 runId 归属确认后填充 —— 守住它的位置：automationAdmission 里的 parsed.automationId 比对 —— 改错故障：普通输入被误标成 schedule，或从无关字符串切出伪 scheduledAt。
// INV-17 断言：技能身份只来自加载结果 metadata，不来自请求参数 —— 守住它的位置：skillTelemetryFactFields 只接 error 或 result 的 skillMetadata —— 改错故障：把请求过某技能记成使用了某技能，能力统计失真。
// INV-18 断言：时间戳与序号只在入口归一一次，下游不再二次解析 —— 守住它的位置：eventTimestamp 与 base 的 eventSeq —— 改错故障：多处各自解析时间会得到不同毫秒，同一事件出现两个发生时刻。
// 本文件没有 IO、没有持久化、没有广播；所有副作用只落在实例内的五张有界旁路表上。
import type {
  CompactLifecyclePayload,
  DynamicWorkflowRunProgressPayload,
  ModelCompletePayload,
  ModelNetworkStatusPayload,
  ModelStreamingPayload,
  PermissionDeniedPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  SessionEvent,
  ToolCallErrorPayload,
  ToolExecutionTelemetry,
  ToolCallProgressPayload,
  ToolCallResultPayload,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
  TurnCompletePayload,
  TurnErrorPayload,
  TurnStartedPayload,
} from "@zcode/contracts";
import { getModelUsageTotalTokens, SessionEventType } from "@zcode/contracts";
import { parseAutomationRunId, sanitizeTelemetrySkillName } from "@zcode/shared";
import { workflowLifecycleFactFromProgress } from "./conversation-telemetry-workflow-facts.js";
import {
  conversationTelemetryFactSchema,
  type ConversationTelemetryFact,
} from "@zcode/shared/zcode-protocol-v4";

// [契约] MAX_TRACKED_LIFECYCLE_KEYS = 2_000 是全局上限，五张旁路表共用同一个数。
// [权衡] 调大只延后淘汰并放大内存，调小会让长会话频繁丢关联，但都不会丢事实。
// [契约] 这个值同时约束首 chunk 集合与四张值表，不要为单表另设上限。
const MAX_TRACKED_LIFECYCLE_KEYS = 2_000;

/**
 * 有界字符串集合：记录“已见过”的键（如首 chunk 签名），超上限按插入序淘汰最旧。
 * add 返回是否首次出现，调用方据此判定 firstChunk；只服务观测去重，不影响产品状态。
 * deletePrefix 用于轮次/会话清理，避免长会话常驻。
 */
class BoundedKeySet {
  // [契约] 集合只存签名键，不存对象引用，避免旁路表反过来延长事件对象的生命周期。
  // [并发] 单进程内 normalize 由调用方串行驱动，这里不再额外加锁。
  // [权衡] 不按轮次分表，BoundedKeySet 的清理统一交给 deletePrefix 完成，不会随轮次增加表数量。
  private readonly keys = new Set<string>();

  // [契约] 返回值等价于首次出现，调用方直接用它填 firstChunk。
  // [并发] 判断与写入必须在同一同步片段内完成，拆开会让同一签名的并发首块都判成首次。
  // [权衡] 已有的键不刷新插入序，所以淘汰顺序是最早写入而不是最久未用。
  // [失败路径] 淘汰只删最旧一个键，容量不会因单次越界而级联清理。
  add(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > MAX_TRACKED_LIFECYCLE_KEYS) {
      const oldest = this.keys.values().next().value;
      if (typeof oldest === "string") this.keys.delete(oldest);
    }
    return true;
  }

  deletePrefix(prefix: string): void {
    for (const key of this.keys) {
      if (key.startsWith(prefix)) this.keys.delete(key);
    }
  }
}

/**
 * 有界 LRU 值表：set 时先删后插，保证淘汰顺序是“最久未写”；超 2000 键丢最旧。
 * 用于 turn→commandId、toolCall→toolName、session→model 等观测关联；容量耗尽只丢观测上下文，
 * 不改变 fact 是否产生（缺失关联时字段省略）。
 */
class BoundedValueMap<T> {
  // [契约] 先删后插是这张表唯一的顺序维护手段，写序即淘汰序。
  // [权衡] 命中时也要重插，才能得到真正的最近最少使用；省掉这一步会淘汰仍在使用的关联。
  // [并发] 同一键的读写都落在 normalize 的同步段内，不存在读到半更新值的窗口。
  // [失败路径] 容量超限只丢最旧键，读取缺失时调用方按缺少字段省略处理。
  private readonly values = new Map<string, T>();

  get(key: string): T | undefined {
    return this.values.get(key);
  }

  set(key: string, value: T): void {
    this.values.delete(key);
    this.values.set(key, value);
    if (this.values.size > MAX_TRACKED_LIFECYCLE_KEYS) {
      const oldest = this.values.keys().next().value;
      if (typeof oldest === "string") this.values.delete(oldest);
    }
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) this.values.delete(key);
    }
  }
}

// [契约] 空字符串与 undefined 在这里被合并成同一种缺失，因为 strict schema 不收空串。
// [权衡] 不裁剪空白也不做类型转换：上游给数字就按缺失处理，避免把 0 变成字符串 0。
// [失败路径] 入参为 null、数组或对象时一律返回 undefined，不抛错也不报警。
// [契约] 这是全文件唯一的字符串判空入口，新增字段不要另写等价判断。
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// [契约] 0 是合法观测值，判据必须是有限且非负，不能用真值判断。
// [权衡] Infinity 与 NaN 都归为缺失，因为 schema 只接受有限数。
// [失败路径] 负数是上游异常信号，这里按缺失丢弃而不是夹到 0，避免伪造数据。
// [契约] 所有 token 与耗时字段都经过它，绕过它直接取值会把脏数据送进 schema。
function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// [契约] 只取主机名，不带端口、路径与查询串，避免把上游地址细节外送。
// [失败路径] 地址非法时静默返回 undefined，观测不能因为配置写错而中断。
// [权衡] providerHostname 不做域名归一也不折叠大小写，保持与请求侧原始值一致。
function providerHostname(baseURL: string | undefined): string | undefined {
  if (!baseURL) return undefined;
  try {
    return new URL(baseURL).hostname || undefined;
  } catch {
    return undefined;
  }
}

// [契约] 数组不算记录，必须显式排除，否则数字下标会被当成字段名读出来。
// [失败路径] null 与基础类型统一退化成空对象，调用方可以无条件取属性。
// [权衡] 每次返回新对象而不是共享常量，避免调用方误改污染其他事件。
function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// [契约] 技能身份只认加载结果 metadata，请求参数不能证明技能真的存在。
// [失败路径] 限定名、插件标识与来源缺失时对应字段整个省略，不写空串。
// [权衡] 名称要求来源同时存在才采信，防止只带名字的中间态被记成已加载。
// [契约] 只有工具名精确等于 Skill 才产出这些字段，不要按前缀或大小写放宽。
function skillTelemetryFactFields(
  toolName: string | undefined,
  metadata: unknown,
): Record<string, unknown> {
  if (toolName !== "Skill") return {};
  const value = recordValue(metadata);
  const qualifiedName = optionalString(value.qualifiedName);
  const pluginId = optionalString(value.pluginId);
  const source = optionalString(value.source);
  // 仅消费加载结果 metadata；请求参数不证明技能存在，不能进入遥测。
  const name =
    source && value.name !== undefined ? sanitizeTelemetrySkillName(value.name) : undefined;
  return {
    ...(name ? { skillName: name } : {}),
    ...(qualifiedName ? { skillQualifiedName: qualifiedName } : {}),
    ...(pluginId ? { skillPluginId: pluginId } : {}),
    ...(source ? { skillSource: source } : {}),
  };
}

/**
 * 从 streaming payload 的多层 _meta 中解析父工具调用 ID（兼容 camel/snake 与多命名空间）。
 *
 * 口径：按优先级取第一个非空字符串；全部缺失返回 undefined（表示本轮主模型流）。
 * 用途：把子工具产生的 chunk 与主轮首 token 区分开，避免子工具输出被误记为 TTFT。
 * 纯读函数，无副作用；字段形状错误按缺失处理，不抛错。
 */
// [契约] 优先级固定为顶层、_meta、zcode 命名空间、claudeCode 命名空间，先到先得。
// [失败路径] 全部缺失返回 undefined，表示主模型流，不能退化成空字符串。
// [权衡] 驼峰与下划线两种写法都认，是为了兼容不同 runtime 的透传层。
// [并发] 纯读函数不写任何表，同一 payload 重复调用必须得到同一结果。
export function streamingParentToolCallId(payload: Record<string, unknown>): string | undefined {
  const meta = recordValue(payload._meta);
  const zcode = recordValue(meta.zcode);
  const claudeCode = recordValue(meta.claudeCode);
  return (
    optionalString(payload.parentToolCallId) ??
    optionalString(payload.parentToolUseId) ??
    optionalString(meta.parentToolCallId) ??
    optionalString(meta.parentToolUseId) ??
    optionalString(zcode.parentToolCallId) ??
    optionalString(zcode.parentToolUseId) ??
    optionalString(claudeCode.parentToolCallId) ??
    optionalString(claudeCode.parentToolUseId)
  );
}

function mirroredSubagentToolFields(
  payload: Record<string, unknown>,
  display: Record<string, unknown> = {},
) {
  const parentToolCallId =
    optionalString(payload.parentToolCallId) ?? optionalString(display.parentToolCallId);
  const childToolCallId =
    optionalString(payload.childToolCallId) ?? optionalString(display.childToolCallId);
  const agentId = optionalString(payload.agentId) ?? optionalString(display.agentId);
  const agentType = optionalString(payload.agentType) ?? optionalString(display.agentType);
  const childSessionId =
    optionalString(payload.childSessionId) ?? optionalString(display.childSessionId);
  return {
    ...(parentToolCallId ? { parentToolCallId } : {}),
    ...(childToolCallId ? { childToolCallId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentType ? { agentType } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    ...(payload.background === true ? { background: true } : {}),
  };
}

// [契约] 输出永远是非负有限毫秒，Date 与数字两种输入都在这里收口。
// [失败路径] 非法时间返回 0，0 表示时间未知，不是纪元时间。
// [权衡] 不用当前时间兜底，否则同一事件重放时会得到不同的发生时间。
// [契约] 下游不再解析原始时间戳字段，改这里等于改全部事实的时间线。
function eventTimestamp(event: SessionEvent): number {
  const value =
    event.timestamp instanceof Date ? event.timestamp.getTime() : Number(event.timestamp);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

// [契约] 只有 runId 解析成功且归属当前 automation 时才补充触发方式。
// [失败路径] 归属不明时只保留关联标识，绝不猜 schedule 或 manual。
// [权衡] 宁可少一个触发维度，也不从无关字符串里切出伪 scheduledAt。
function automationAdmission(inputId: string | undefined, automationId: string | undefined) {
  if (!inputId || !automationId) return {};
  const parsed = parseAutomationRunId(inputId);
  // inputId 不是本 automation 的 runId（历史入口漏传、异常透传）时不猜触发方式：
  // 只保留关联 ID，避免把普通输入误标成 schedule 或从无关字符串切出伪 scheduledAt。
  if (!parsed || parsed.automationId !== automationId) return { automationId };
  return {
    automationId,
    taskTrigger: parsed.trigger,
    ...(parsed.scheduledAt !== undefined ? { scheduledAt: parsed.scheduledAt } : {}),
  };
}

function cronCreateAutomationId(content: unknown): string | undefined {
  let value = content;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  const parsed = recordValue(value);
  return optionalString(recordValue(parsed.automation).automationId);
}

// [契约] 总量计算收敛到共享工具，本文件不自己相加各分项。
// [权衡] 缓存读缺失时回退到旧字段 cacheTokens，兼容历史事件。
// [失败路径] 任一分项缺失按 undefined 传入，由共享工具决定是否用分项之和。
// [契约] 不要在调用处提前给分项补 0，会把缺失变成确实是 0。
function totalTokensOf(usage: Record<string, unknown>): number {
  return getModelUsageTotalTokens({
    totalTokens: nonNegative(usage.totalTokens),
    inputTokens: nonNegative(usage.inputTokens),
    outputTokens: nonNegative(usage.outputTokens),
    cacheReadTokens: nonNegative(usage.cacheReadTokens) ?? nonNegative(usage.cacheTokens),
    cacheWriteTokens: nonNegative(usage.cacheWriteTokens),
    reasoningTokens: nonNegative(usage.reasoningTokens),
  });
}

// [契约] 这是性能字段的白名单类型，只允许 schema 声明过的键出现。
// [权衡] detail 是 runtime 内部结构，透传会把本地诊断字段带进 strict fact。
// [失败路径] 白名单映射后一个键都没有时返回 undefined，而不是空对象。
// [契约] 命令哈希一类字段永远不进事实，排障信息留在本地日志。
type ToolPerformanceFact = NonNullable<
  Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>["performance"]
>;

function toToolPerformanceFact(
  perf: ToolExecutionTelemetry | undefined,
): ToolPerformanceFact | undefined {
  if (!perf) return undefined;
  const command = perf.detail?.kind === "command" ? perf.detail.command : undefined;
  const filesystem =
    perf.detail?.kind === "filesystem" || perf.detail?.kind === "patch"
      ? perf.detail.filesystem
      : undefined;
  const patch = perf.detail?.kind === "patch" ? perf.detail.patch : undefined;
  const fact: ToolPerformanceFact = {
    ...(perf.totalMs !== undefined ? { totalMs: perf.totalMs } : {}),
    ...(perf.permissionWaitMs !== undefined ? { permissionWaitMs: perf.permissionWaitMs } : {}),
    ...(command?.runMs !== undefined ? { commandRunMs: command.runMs } : {}),
    ...(command?.firstOutputMs !== undefined ? { firstOutputMs: command.firstOutputMs } : {}),
    ...(command?.noOutputMs !== undefined ? { noOutputMs: command.noOutputMs } : {}),
    ...(command?.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
    ...(command?.timedOut !== undefined ? { timedOut: command.timedOut } : {}),
    ...(command?.outputBytes !== undefined ? { outputBytes: command.outputBytes } : {}),
    ...(command?.category !== undefined ? { commandCategory: command.category } : {}),
    ...(command?.name !== undefined ? { commandName: command.name } : {}),
    ...(command?.count !== undefined ? { commandCount: command.count } : {}),
    ...(command?.status !== undefined ? { commandStatus: command.status } : {}),
    ...(filesystem?.readMs !== undefined ? { fsReadMs: filesystem.readMs } : {}),
    ...(filesystem?.writeMs !== undefined ? { fsWriteMs: filesystem.writeMs } : {}),
    ...(filesystem?.fileCount !== undefined ? { fileCount: filesystem.fileCount } : {}),
    ...(filesystem?.totalBytes !== undefined ? { totalBytes: filesystem.totalBytes } : {}),
    ...(filesystem?.maxFileBytes !== undefined ? { maxFileBytes: filesystem.maxFileBytes } : {}),
    ...(filesystem?.workspaceKind !== undefined ? { workspaceKind: filesystem.workspaceKind } : {}),
    ...(patch?.matchMs !== undefined ? { patchMatchMs: patch.matchMs } : {}),
    ...(patch?.hunkCount !== undefined ? { hunkCount: patch.hunkCount } : {}),
    ...(patch?.matchAttempts !== undefined ? { matchAttempts: patch.matchAttempts } : {}),
  };
  return Object.keys(fact).length > 0 ? fact : undefined;
}

function terminalStatus(resultType: string): "success" | "interrupted" | "failed" {
  if (resultType === "success") return "success";
  if (resultType === "cancelled") return "interrupted";
  return "failed";
}

interface CompletedModelRequestIdentity {
  requestId: string;
  providerId: string;
  modelId: string;
  providerKind?: string;
  providerHostname?: string;
}

// [契约] 用 NUL 拼接而不是冒号或竖线，避免标识里出现同字符造成串键。
// [权衡] undefined 与空串在这里折叠成同一个键，二者都表示主轮来源。
// [失败路径] 来源只做原样保留，不做归一或大小写折叠。
// [契约] 入队与出队必须用同一个函数生成键，手写拼接会出现永远配不上的队列。
function modelRequestQueueKey(sessionId: string, querySource: string | undefined): string {
  return `${sessionId}\0${querySource ?? ""}`;
}

// [契约] 白名单只放主轮、子代理、动态工作流子代理与历史无来源事件。
// [权衡] workflow_child 必须放行，否则子代理的 token 进不了业务埋点。
// [失败路径] 未列出的来源一律不产 usage，包括标题 sidecar 与 compact。
// [契约] 新增来源要同时评估是否该计入用量，不能顺手加进这个判断。
function isStepUsageQuerySource(querySource: string | undefined): boolean {
  // `workflow_child`：动态工作流子代理。
  // 该来源必须放行，否则子代理的 token 进不了业务埋点。
  return (
    querySource === undefined ||
    querySource === "main_turn" ||
    querySource === "subagent" ||
    querySource === "workflow_child"
  );
}

function isStepUsageModelComplete(payload: ModelCompletePayload): boolean {
  return (
    isStepUsageQuerySource(payload.querySource) &&
    (payload.querySource !== undefined || payload.stopReason !== "tool_internal")
  );
}

// [契约] 只有完成、失败、中断三种状态算终态，其余返回 null 表示不产事实。
// [失败路径] 状态枚举扩展时这里必须同步，否则新终态会被静默丢弃。
// [权衡] 不做字符串归一，未知状态一律当非终态，避免把中间态误报成结束。
function compactTerminalStatus(
  status: CompactLifecyclePayload["status"],
): "completed" | "failed" | "interrupted" | null {
  switch (status) {
    case "completed":
    case "failed":
    case "interrupted":
      return status;
    default:
      return null;
  }
}

/**
 * 把本进程 live SessionEvent 中的轮次起止归一成 `turn.started` / `turn.terminal` 事实，
 * 供 App/服务端统计运行中的会话数。事实不带正文，只带 admission 给出的 inputId 与终态摘要。
 * 该类不读取 transcript/snapshot，因而无法在 hydration/recovery 时补造事件。
 */
// [契约] 该类持有五张旁路表，是观测关联的唯一所有者，外部不得直接读写。
// [并发] 同一实例的 normalize 由调用方串行驱动，本类不做跨线程同步。
// [失败路径] schema 校验失败向上抛出，由调用方按观测失败丢弃，不回滚用户轮次。
// [契约] 旁路表只服务字段补齐，任何需要产品态才能得到的字段都不放进事实。
// 职责边界：八类 kind 的统一入口，只做观测事实转换，不修改任何产品态。
// base 统一携带 eventId/eventSeq/occurredAt/sessionId/turnId，sourceCommandId 由 turn 关联补齐。
// 聚合口径：stream 只标首个 chunk；ModelComplete 与先前 completed request 按 session+querySource
// 队列配对；token 用量只外送 main/subagent/workflow_child。
// 失败降级：准入等待等“不收”的事件显式返回 null；字段缺失省略可选字段，观测异常不得阻断主轮。
// 不变量：turn 终态必清 turnKey 关联；clearSession 按 session 前缀清空全部旁路状态。
export class ConversationTelemetryFactNormalizer {
  // [契约] 首块去重表按会话与轮次前缀清理，跨轮不会互相影响。
  // [权衡] 这张表丢键只会让某个流被多标一次首块，不会改变事实是否产生。
  // [失败路径] 会话切换必须经 clearSession 清空，否则同签名的新会话会被判成非首块。
  private readonly firstStreamChunks = new BoundedKeySet();
  private readonly sourceCommandByTurn = new BoundedValueMap<string>();
  private readonly toolNameByCall = new BoundedValueMap<string>();
  private readonly modelBySession = new BoundedValueMap<{
    modelName: string;
    modelProvider: string;
  }>();
  private readonly completedModelRequests = new BoundedValueMap<CompletedModelRequestIdentity[]>();

  /**
   * 归一单条事件：按 EventType 分派到八类 fact，并维护跨事件的观测关联。
   *
   * 输入：sessionId、live SessionEvent、可选 runtime metadata（模型名/Provider/memory 开关）。
   * 输出：strict schema fact 或 null（null 表示该事件不产观测，而不是故障）。
   * 副作用：仅更新本类有界旁路表（turn→command、tool→name、session→model、completed request 队列）；
   * 不写 transcript、不改 projection、不发帧。
   * 失败/降级：字段缺失时省略对应可选字段；不该外送的请求状态（queued/admitted、标题 sidecar、
   * compact/tool_internal usage）显式跳过；观测链路的异常不得阻断主轮。
   */
  // [契约] 返回 null 是正常语义，表示这条事件不产观测，调用方不得当作异常。
  // [失败路径] 只有 schema 校验失败才会抛，那是契约不一致，应该暴露而不是吞掉。
  // [并发] 一次调用内的旁路表更新与事实构造必须保持先后顺序，不要提前清理。
  // [权衡] 分派用事件类型而不是 payload 形状，形状只用于同类事件内部区分阶段。
  normalize(
    sessionId: string,
    event: SessionEvent,
    runtimeMetadata?: { modelName?: string; modelProvider?: string; memoryEnabled?: boolean },
  ): ConversationTelemetryFact | null {
    const turnId = event.turnId ? String(event.turnId) : undefined;
    const turnKey = turnId ? `${sessionId}\0${turnId}` : undefined;
    // [契约] 信封字段在这里一次成型，任何 case 都不再修改事件标识与发生时间。
    // [并发] 序号取整并夹到非负，避免上游浮点或负数让 schema 拒收。
    // [失败路径] 内存开关只在显式给出时写入，缺失表示未观测而不是关闭。
    // [权衡] 版本号写死为 1，升级协议要另开事实版本，不能热改这个常量。
    const base = {
      ...(runtimeMetadata?.memoryEnabled !== undefined
        ? { memoryEnabled: runtimeMetadata.memoryEnabled }
        : {}),
      version: 1 as const,
      eventId: String(event.id),
      eventSeq: Math.max(0, Math.floor(event.sequenceNumber)),
      occurredAt: eventTimestamp(event),
      sessionId,
      ...(turnId ? { turnId } : {}),
    };
    const sourceCommandId = turnKey ? this.sourceCommandByTurn.get(turnKey) : undefined;

    switch (event.type) {
      // [契约] 用户轮与后台唤醒都用准入层给的输入标识，不复用持久化消息标识。
      // [失败路径] 输入标识缺失时不写来源命令字段，仍要产出轮次开始事实。
      // [权衡] sourceCommandByTurn 只在 TurnStarted 分支登记，后续工具与用量事实靠它补齐来源命令。
      case SessionEventType.TurnStarted: {
        const payload = event.payload as TurnStartedPayload;
        const backgroundSource =
          payload.backgroundSource === "bash" ||
          payload.backgroundSource === "subagent" ||
          payload.backgroundSource === "workflow"
            ? payload.backgroundSource
            : undefined;
        // 用户轮与 background wake 均由 admission 提供 inputId，不混用持久化 messageId。
        const inputId = optionalString(payload.inputId);
        if (turnKey && inputId) this.sourceCommandByTurn.set(turnKey, inputId);
        return conversationTelemetryFactSchema.parse({
          ...base,
          kind: "turn.started",
          ...(inputId ? { sourceCommandId: inputId } : {}),
          ...automationAdmission(inputId, optionalString(payload.automationId)),
          ...(optionalString(payload.offPeakTaskId)
            ? { offPeakTaskId: optionalString(payload.offPeakTaskId) }
            : {}),
          ...(payload.offPeakRunType ? { offPeakRunType: payload.offPeakRunType } : {}),
          ...(payload.executionKind ? { executionKind: payload.executionKind } : {}),
          ...(payload.inputSource ? { inputSource: payload.inputSource } : {}),
          ...(backgroundSource ? { backgroundSource } : {}),
        });
      }
      // [契约] 准入等待的排队与放行不是 provider 请求状态，必须在构造前早退。
      // [失败路径] 让它们进 schema 会直接抛错，连带丢掉本可观测的网络状态。
      // [权衡] 早退发生在任何缓存写入之前，模型缓存不会被准入事件覆盖。
      // [契约] 状态枚举按 payload 原样外送，本文件不做二次映射或合并。
      case SessionEventType.ModelNetworkStatus: {
        const payload = event.payload as ModelNetworkStatusPayload;
        // 准入等待的两端不是 provider 请求状态：
        // fact 的 status 枚举不收它们，显式跳过而不是让 schema.parse 抛出。
        if (payload.type === "model_request_queued" || payload.type === "model_request_admitted") {
          return null;
        }
        const modelProvider = String(payload.providerId);
        const modelName = String(payload.modelId);
        // [契约] 模型缓存写入放在事实构造之前，即使这条事实被丢弃，后续压缩仍能借到模型。
        // [权衡] 覆盖写而不是先进先出，会话最后一次观测到的模型才是压缩事实要的。
        // [失败路径] 缓存缺失时压缩分支回退到运行时元数据，不会因此不产事实。
        this.modelBySession.set(sessionId, { modelName, modelProvider });
        const fact = conversationTelemetryFactSchema.parse({
          ...base,
          kind: "model.request.status",
          ...(sourceCommandId ? { sourceCommandId } : {}),
          requestId: String(payload.requestId),
          status: payload.type,
          providerId: modelProvider,
          modelId: modelName,
          ...(payload.providerKind ? { providerKind: payload.providerKind } : {}),
          ...(providerHostname(payload.baseURL)
            ? { providerHostname: providerHostname(payload.baseURL) }
            : {}),
          transport: payload.transport,
          ...(payload.querySource ? { querySource: payload.querySource } : {}),
          ...(payload.queryId ? { queryId: String(payload.queryId) } : {}),
          attempt: payload.attempt,
          maxAttempts: payload.maxAttempts,
          ...(payload.type === "model_request_completed"
            ? {
                durationMs: payload.durationMs,
              }
            : {}),
          ...(payload.type === "model_request_failed"
            ? {
                ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
                reason: payload.reason,
                retryable: payload.retryable,
                ...(payload.statusCode !== undefined ? { statusCode: payload.statusCode } : {}),
              }
            : {}),
          ...(payload.type === "model_retry_scheduled"
            ? {
                delayMs: payload.delayMs,
                nextAttempt: payload.nextAttempt,
                reason: payload.reason,
                ...(payload.statusCode !== undefined ? { statusCode: payload.statusCode } : {}),
              }
            : {}),
          ...(payload.type === "model_stream_stalled"
            ? { idleMs: payload.idleMs, timeoutMs: payload.timeoutMs }
            : {}),
        });
        // [契约] 只有已完成且来源在用量白名单内才入队，其他状态不进队列。
        // [并发] 入队发生在事实构造之后，保证被 schema 拒收的事件不会留下配对残留。
        // [权衡] 队列是数组而不是集合，同一来源可能并发多个请求，需要按序配对。
        // [失败路径] 队列不设单独容量，跟随所在有界表一起淘汰。
        const querySource = optionalString(payload.querySource);
        if (payload.type === "model_request_completed" && isStepUsageQuerySource(querySource)) {
          const key = modelRequestQueueKey(sessionId, querySource);
          const queue = this.completedModelRequests.get(key) ?? [];
          queue.push({
            requestId: String(payload.requestId),
            providerId: modelProvider,
            modelId: modelName,
            ...(payload.providerKind ? { providerKind: payload.providerKind } : {}),
            ...(providerHostname(payload.baseURL)
              ? { providerHostname: providerHostname(payload.baseURL) }
              : {}),
          });
          this.completedModelRequests.set(key, queue);
        }
        return fact;
      }
      case SessionEventType.ModelStreaming: {
        const payload = event.payload as ModelStreamingPayload;
        const rawPayload = recordValue(event.payload);
        const channel =
          payload.kind === "text_delta"
            ? "text"
            : payload.kind === "reasoning_delta"
              ? "thought"
              : null;
        if (!channel) return null;
        const parentToolCallId = streamingParentToolCallId(rawPayload);
        // [契约] 键里必须包含父工具调用标识，子工具输出才不会被当成本轮首 token。
        // [权衡] 空值统一成空串再拼接，保证同一缺失状态在不同事件里得到同一个键。
        // [失败路径] 部件标识与轮次缺失时仍能生成键，代价是跨轮同部件会被合并去重。
        // [契约] 键格式一旦上线不能随意改，改了等于所有在途流的首块标记重置。
        const streamKey = `${sessionId}\0${turnId ?? ""}\0${channel}\0${String(payload.partId ?? "")}\0${parentToolCallId ?? ""}`;
        return conversationTelemetryFactSchema.parse({
          ...base,
          kind: "stream.chunk",
          ...(sourceCommandId ? { sourceCommandId } : {}),
          channel,
          chunkLength: payload.delta.length,
          // [契约] 追加操作有副作用且只在这里调用一次，随对象展开与事实同时生成。
          // [失败路径] 不要为了取值再调用一次，第二次必然返回否，首块标记会被改错。
          // [权衡] 即使后续 schema 校验失败，这个键也已写入，首块不会重复上报。
          firstChunk: this.firstStreamChunks.add(streamKey),
          ...(payload.assistantMessageId
            ? { assistantMessageId: String(payload.assistantMessageId) }
            : {}),
          ...(payload.partId ? { partId: String(payload.partId) } : {}),
          ...(parentToolCallId ? { parentToolCallId } : {}),
        });
      }
      case SessionEventType.ToolCallScheduled: {
        const payload = event.payload as ToolCallScheduledPayload;
        const rawPayload = recordValue(event.payload);
        const toolCallId = String(payload.toolCallId);
        this.toolNameByCall.set(`${turnKey ?? sessionId}\0${toolCallId}`, payload.toolName);
        return conversationTelemetryFactSchema.parse({
          ...base,
          kind: "tool.lifecycle",
          ...(sourceCommandId ? { sourceCommandId } : {}),
          phase: "scheduled",
          toolCallId,
          toolName: payload.toolName,
          ...mirroredSubagentToolFields(rawPayload),
        });
      }
      case SessionEventType.ToolCallStarted:
      case SessionEventType.ToolCallProgress:
      case SessionEventType.ToolCallResult:
      case SessionEventType.ToolCallError: {
        const payload = event.payload as
          | ToolCallStartedPayload
          | ToolCallProgressPayload
          | ToolCallResultPayload
          | ToolCallErrorPayload;
        const rawPayload = recordValue(event.payload);
        const toolCallId = String(payload.toolCallId);
        const key = `${turnKey ?? sessionId}\0${toolCallId}`;
        // [契约] 事件自带的工具名优先，缓存只在缺少显式字段时补齐。
        // [权衡] 调度事件写入的缓存不覆盖显式值，避免旧名压过新名。
        // [失败路径] 两者都缺失时不写工具名字段，工具终态仍然照常产出。
        const explicitName = "toolName" in payload ? optionalString(payload.toolName) : undefined;
        const toolName = explicitName ?? this.toolNameByCall.get(key);
        const result =
          event.type === SessionEventType.ToolCallResult
            ? (payload as ToolCallResultPayload)
            : null;
        const error =
          event.type === SessionEventType.ToolCallError ? (payload as ToolCallErrorPayload) : null;
        const display = recordValue(result?.result.display);
        // runtime 把 perf 改为 nested detail，旧 normalizer 仍把它
        // 原样塞进扁平 strict fact，导致整条工具终态被丢弃。这里必须只做显式白名单映射，
        // 不能再次透传 detail 或本地诊断用的 command.hash。
        const performance = toToolPerformanceFact(result?.result.perf);
        const phase =
          event.type === SessionEventType.ToolCallStarted
            ? "started"
            : event.type === SessionEventType.ToolCallProgress
              ? "progress"
              : event.type === SessionEventType.ToolCallResult
                ? result?.result.success === false
                  ? "failed"
                  : "completed"
                : "failed";
        // [契约] 只有工具终态且工具名精确为定时任务创建才尝试解析自动化标识。
        // [失败路径] 内容不是 JSON 或结构不符时返回 undefined，不影响工具事实本身。
        // [权衡] 解析的是执行结果内容而不是请求参数，参数不能证明创建成功。
        const automationId =
          phase === "completed" && toolName === "CronCreate"
            ? cronCreateAutomationId(result?.result.content)
            : undefined;
        if (phase === "completed" || phase === "failed") this.toolNameByCall.delete(key);
        return conversationTelemetryFactSchema.parse({
          ...base,
          kind: "tool.lifecycle",
          ...(sourceCommandId ? { sourceCommandId } : {}),
          phase,
          toolCallId,
          ...(toolName ? { toolName } : {}),
          ...(automationId ? { automationId } : {}),
          ...(result ? { durationMs: result.duration } : {}),
          ...(error ? { errorCode: error.error.code ?? error.error.type } : {}),
          ...(error ? { errorMessage: error.error.message } : {}),
          ...(result?.result.error
            ? { errorCode: result.result.error.code ?? result.result.error.type }
            : {}),
          ...(result?.result.error ? { errorMessage: result.result.error.message } : {}),
          ...skillTelemetryFactFields(toolName, error?.skillMetadata ?? result?.skillMetadata),
          ...((error?.pluginId ?? result?.pluginId)
            ? { pluginId: error?.pluginId ?? result?.pluginId, pluginComponent: "mcp" }
            : {}),
          // subagent mirror 把父子关联放在工具事件 payload 顶层，旧 normalizer
          // 只读取 result.display，导致 agent_id 等字段在进入 agent_step 前被静默丢弃。
          ...mirroredSubagentToolFields(rawPayload, display),
          ...(performance ? { performance } : {}),
        });
      }
      case SessionEventType.PermissionRequested:
      case SessionEventType.PermissionResolved:
      case SessionEventType.PermissionDenied: {
        const payload = event.payload as
          | PermissionRequestedPayload
          | PermissionResolvedPayload
          | PermissionDeniedPayload;
        const rawPayload = recordValue(payload);
        const requested =
          event.type === SessionEventType.PermissionRequested
            ? (payload as PermissionRequestedPayload)
            : null;
        const resolved =
          event.type === SessionEventType.PermissionResolved
            ? (payload as PermissionResolvedPayload)
            : null;
        const denied =
          event.type === SessionEventType.PermissionDenied
            ? (payload as PermissionDeniedPayload)
            : null;
        return conversationTelemetryFactSchema.parse({
          ...base,
          kind: "permission.lifecycle",
          ...(sourceCommandId ? { sourceCommandId } : {}),
          phase: requested ? "requested" : resolved ? "resolved" : "denied",
          ...(optionalString(requested?.requestId ?? resolved?.requestId)
            ? { requestId: optionalString(requested?.requestId ?? resolved?.requestId) }
            : {}),
          toolCallId: String(payload.toolCallId),
          ...(requested?.toolName
            ? { toolName: requested.toolName }
            : denied?.toolName
              ? { toolName: denied.toolName }
              : {}),
          ...(optionalString(rawPayload.childSessionId)
            ? { childSessionId: optionalString(rawPayload.childSessionId) }
            : {}),
          ...(rawPayload.background === true ? { background: true } : {}),
          ...(resolved ? { decision: resolved.decision } : {}),
        });
      }
      // [契约] 出队先于用量准入判断，保证队列与事件顺序一一对应。
      // [权衡] 顺序反了会让被拒绝的完成事件留下未消费的请求，后续用量整体错位。
      // [失败路径] 队列取空后立即删键，避免空数组长期占位被容量淘汰机制误伤。
      // [契约] 标题 sidecar 与压缩的完成事件在这里被挡掉，不能进主对话用量。
      case SessionEventType.ModelComplete: {
        const payload = event.payload as ModelCompletePayload;
        const requestQueueKey = modelRequestQueueKey(
          sessionId,
          optionalString(payload.querySource),
        );
        const completedRequests = this.completedModelRequests.get(requestQueueKey) ?? [];
        const completedRequest = completedRequests.shift();
        if (completedRequests.length > 0) {
          this.completedModelRequests.set(requestQueueKey, completedRequests);
        } else {
          this.completedModelRequests.delete(requestQueueKey);
        }
        // 标题 sidecar 沿用当前 turnId，若把它的 ModelComplete 也转成
        // usage.delta，renderer 会把每轮标题的 64/8 tokens 累加进主对话 completion。
        // 本期只放行主轮和 subagent request usage；sidecar/compact/tool_internal 仍不外送。
        if (!isStepUsageModelComplete(payload)) return null;
        const usage = recordValue(payload.usage);
        return conversationTelemetryFactSchema.parse({
          ...base,
          kind: "usage.delta",
          ...(sourceCommandId ? { sourceCommandId } : {}),
          ...(completedRequest
            ? {
                requestId: completedRequest.requestId,
                providerId: completedRequest.providerId,
                modelId: completedRequest.modelId,
                ...(completedRequest.providerKind
                  ? { providerKind: completedRequest.providerKind }
                  : {}),
                ...(completedRequest.providerHostname
                  ? { providerHostname: completedRequest.providerHostname }
                  : {}),
              }
            : {}),
          // [契约] 用量事实的数值字段必填，缺失在这里补 0 而不是省略字段。
          // [权衡] 0 表示上游没给，与真实的零用量在统计上不可区分，这是为了满足 strict schema。
          // [失败路径] 负值经非负判断变成缺失再被 0 兜底，不会外送异常数字。
          inputTokens: nonNegative(usage.inputTokens) ?? 0,
          outputTokens: nonNegative(usage.outputTokens) ?? 0,
          totalTokens: totalTokensOf(usage),
          reasoningTokens: nonNegative(usage.reasoningTokens) ?? 0,
          cacheReadTokens:
            nonNegative(usage.cacheReadTokens) ?? nonNegative(usage.cacheTokens) ?? 0,
          cacheWriteTokens: nonNegative(usage.cacheWriteTokens) ?? 0,
        });
      }
      case SessionEventType.DynamicWorkflowRunProgress: {
        // 动态工作流子代理的归属事实：actor-created 登记、
        // run-settled 结算；其余引擎事件不进埋点。
        return workflowLifecycleFactFromProgress(
          base,
          event.payload as DynamicWorkflowRunProgressPayload,
        );
      }
      // [契约] 子代理事实要求代理标识与子会话标识同时存在，缺一个就不产事实。
      // [失败路径] 缺失时返回 null，而不是写空串让下游按无效身份聚合。
      // [权衡] 停止事件允许独立收口并保留错误信息，避免后台失败原因丢失。
      case SessionEventType.SubagentSpawned:
      case SessionEventType.SubagentStopped: {
        const payload = recordValue(event.payload);
        const agentId = optionalString(payload.agentId);
        const childSessionId = optionalString(payload.childSessionId);
        if (!agentId || !childSessionId) return null;
        return conversationTelemetryFactSchema.parse({
          ...base,
          kind: "subagent.lifecycle",
          ...(sourceCommandId ? { sourceCommandId } : {}),
          phase: event.type === SessionEventType.SubagentSpawned ? "spawned" : "stopped",
          agentId,
          ...(optionalString(payload.agentType)
            ? { agentType: optionalString(payload.agentType) }
            : {}),
          childSessionId,
          ...(optionalString(payload.parentToolCallId)
            ? { parentToolCallId: optionalString(payload.parentToolCallId) }
            : {}),
          background: payload.background === true,
          ...(optionalString(payload.status) ? { status: optionalString(payload.status) } : {}),
          // stopped 可独立收口后台埋点；保留 Runtime 已有错误，避免失败汇总丢失原因。
          ...(event.type === SessionEventType.SubagentStopped && optionalString(payload.error)
            ? { errorMessage: optionalString(payload.error) }
            : {}),
        });
      }
      case SessionEventType.TurnComplete: {
        const payload = event.payload as TurnCompletePayload;
        const directSourceCommandId = optionalString(payload.inputId) ?? sourceCommandId;
        const fact = conversationTelemetryFactSchema.parse({
          ...base,
          kind: "turn.terminal",
          ...(directSourceCommandId ? { sourceCommandId: directSourceCommandId } : {}),
          status: terminalStatus(payload.resultType),
          resultType: payload.resultType,
          durationMs: payload.duration,
          tokenCount: payload.tokenCount,
          toolCallCount: payload.toolCallCount,
          ...(payload.resultType === "cancelled"
            ? {
                errorCode: "USER_INTERRUPT",
                errorMessage: "User stopped generation",
              }
            : {}),
          ...(payload.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(payload.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
        });
        // [契约] 清理只在事实构造成功后执行，schema 抛错时旁路表保持原样等待会话级清理。
        // [权衡] 提前清理会让同轮后续事件丢掉来源命令与工具名关联。
        // [并发] 清理是同步的，不存在事实已发出而表还没清的中间态被其他事件读到。
        this.clearTurn(turnKey);
        return fact;
      }
      case SessionEventType.TurnError: {
        const payload = event.payload as TurnErrorPayload;
        const directSourceCommandId = optionalString(payload.inputId) ?? sourceCommandId;
        const fact = conversationTelemetryFactSchema.parse({
          ...base,
          kind: "turn.terminal",
          ...(directSourceCommandId ? { sourceCommandId: directSourceCommandId } : {}),
          status: "failed",
          errorCode: payload.error.code ?? payload.error.type,
          errorMessage: payload.error.message,
          ...(payload.error.retryable !== undefined
            ? { errorRetryable: payload.error.retryable }
            : {}),
          ...(payload.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(payload.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
          turnPhase: payload.turnPhase,
        });
        this.clearTurn(turnKey);
        return fact;
      }
      case SessionEventType.CompactCompleted:
      case SessionEventType.CompactFailed: {
        const payload = event.payload as CompactLifecyclePayload;
        const status = compactTerminalStatus(payload.status);
        if (!status) return null;
        const observedModel = this.modelBySession.get(sessionId);
        const model =
          observedModel ??
          (runtimeMetadata?.modelName || runtimeMetadata?.modelProvider
            ? {
                modelName: runtimeMetadata.modelName ?? "",
                modelProvider: runtimeMetadata.modelProvider ?? "",
              }
            : undefined);
        return conversationTelemetryFactSchema.parse({
          ...base,
          kind: "compaction.terminal",
          ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
          operationId: payload.operationId,
          ...(payload.messageId ? { messageId: String(payload.messageId) } : {}),
          ...(payload.summaryMessageId
            ? { summaryMessageId: String(payload.summaryMessageId) }
            : {}),
          status,
          trigger: payload.trigger,
          ...(payload.compactReason ? { compactReason: payload.compactReason } : {}),
          ...(payload.reason ? { reason: payload.reason } : {}),
          ...(payload.attempt !== undefined ? { attempt: payload.attempt } : {}),
          ...(payload.maxAttempts !== undefined ? { maxAttempts: payload.maxAttempts } : {}),
          ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
          ...(payload.endedAt !== undefined ? { endedAt: payload.endedAt } : {}),
          ...(payload.preCompactTokenCount !== undefined
            ? { preCompactTokenCount: payload.preCompactTokenCount }
            : {}),
          ...(payload.postCompactTokenCount !== undefined
            ? { postCompactTokenCount: payload.postCompactTokenCount }
            : {}),
          ...(payload.truePostCompactTokenCount !== undefined
            ? { truePostCompactTokenCount: payload.truePostCompactTokenCount }
            : {}),
          ...(model ? model : {}),
        });
      }
      default:
        return null;
    }
  }

  /**
   * 轮次结束后的旁路清理：删 turn→commandId 映射，并按 `${turnKey}\0` 前缀清首 chunk 与工具名。
   * 只在 terminal 事实已经构造成功后调用；turnKey 缺失时无操作。
   */
  // [契约] 轮次级清理的三段前缀都带 NUL，防止会话标识前缀相近时误删其他轮。
  // [失败路径] 轮次键缺失时直接返回，会话级事实没有轮次关联可清。
  // [权衡] 只清轮次作用域，模型缓存与请求队列要留给会话级清理处理。
  private clearTurn(turnKey: string | undefined): void {
    if (!turnKey) return;
    this.sourceCommandByTurn.delete(turnKey);
    this.firstStreamChunks.deletePrefix(`${turnKey}\0`);
    this.toolNameByCall.deletePrefix(`${turnKey}\0`);
  }

  /**
   * 会话销毁/切换时的全量清理：按 sessionId 前缀删 turn 关联、首 chunk、工具名，
   * 以及 session 级 model 缓存与 completed request 队列。
   * 幂等、无副作用；不清理已送出的 fact（观测通道自负责）。
   */
  // [契约] 会话销毁要清五处状态：轮次来源、首块、工具名、模型缓存、完成请求队列。
  // [失败路径] 漏清队列会让新会话复用旧请求，用量配到错误的请求标识上。
  // [权衡] 按前缀扫描而不是重建整表，规模受容量上限约束。
  // [契约] 该方法幂等，重复调用没有副作用，也不负责撤销已经送出的事实。
  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    this.sourceCommandByTurn.deletePrefix(prefix);
    this.firstStreamChunks.deletePrefix(prefix);
    this.toolNameByCall.deletePrefix(prefix);
    this.modelBySession.delete(sessionId);
    this.completedModelRequests.deletePrefix(prefix);
  }
}
