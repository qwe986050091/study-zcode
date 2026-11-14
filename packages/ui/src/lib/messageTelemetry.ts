/* oxlint-disable eslint(max-lines) -- message_completion 与 agent_step 共用 prompt 生命周期状态，拆分会增加跨文件同步复杂度。 */
//
// ============================================================
// packages/ui/src/lib/messageTelemetry.ts —— 消息级遥测（message_completion / agent_step）
//
// 定位：把一次 prompt 从「排队 → 激活 → 模型请求 → 工具调用 → 终态」的全过程聚合成两类数仓事实。
// 本文件只采集与聚合，不负责上报；上报端拿到 eventExtraDetail 后再落数仓。
//
// 为什么采集必须集中在一个模块：
// - 采集点分散在流事件回调、权限弹窗、文件变更、子代理归因等多个入口；若各入口自行拼字段，
//   同名字段会出现多套口径（model_provider 一处是内部 uuid、另一处是 provider id）。
// - 因此字符串归一一律收在本文件出口（legacyTelemetry* / sanitizeTelemetrySkillName），
//   调用方只允许传原始事实，不允许预先格式化后再传进来。
//
// INV-1: 同一 taskId 至多一个 active prompt 与一个 agent step state；激活时从队列摘除而非复制。
//        破坏后果：两份 state 各自收口，agent_step_cnt / tool_call_total 翻倍，completion 被后写者覆盖。
// INV-2: stepId 只在 createAgentStep 分配一次，之后任何路径都不得重写或复用。
//        破坏后果：数仓按 step_id 去重会把两轮 loop 折叠成一行，agent_step 数量系统性失真。
// INV-3: step.model 在创建时快照 currentModelRequest，终态不再回读 prompt 共享字段。
//        破坏后果：后续主请求或 child 请求覆盖后，历史 step 挂上新模型，token 归因到错误模型。
// INV-4: usage 的 eventKey 去重（usageEventKeys）是幂等的唯一屏障。
//        破坏后果：重连/重放会重复累加 token，成本与吞吐报表直接翻倍。
// INV-5: pending usage 必须归属到「产生它的 requestId」对应的 step，找不到才暂存。
//        破坏后果：被随后创建的工具 step 消费后，主模型 token 会算进 subagent 维度。
// INV-6: permission 等待在 settle 时从 permissionWaitsByRequestId 删除，且只结算一次。
//        破坏后果：重复 settle 让 waiting_ms 翻倍，已收口等待还会被二次分摊到工具 step。
// INV-7: firstTokenAt 用 null 表示「未发生」，只在第一次写入。
//        破坏后果：重复写入会把 TTFT 改成最后一个 token 的时间，首字延迟被系统性低估。
// INV-8: 所有时长字段在出口一律 Math.max(x, 0)。
//        破坏后果：时钟回拨或跨机时间差会产生负 duration，数仓分位统计出现负值。
// INV-9: task_complete / task_error 收口后必须删除 agentStepTelemetryByTask。
//        破坏后果：下一条消息复用上一条的 loopIndex 与残留 step，序号与归属全部错位。
// INV-10: 所有 record* 入口对未知 taskId 静默返回，绝不抛错。
//         破坏后果：遥测故障会升级成对话中断，违背「可观测性不得影响主流程」这一前提。
// INV-11: 只上报标识类字段（模型/插件/skill 名、错误摘要），不上报 prompt 正文与文件内容。
//         破坏后果：用户代码与提示词进入数仓，构成越权数据外流。
// INV-12: clientMode=web-remote-replayable 不计算 generation_tail_finalize_ms。
//         破坏后果：客户端重放时间被当成源端尾包延迟，P99 尾延迟被虚假放大。
// INV-13: finalizedAgentStepCount 在逐 step 收口处累加，不在 completion 时回扫历史消息。
//         破坏后果：后一轮把历史 step/tool 重复计入，agent_step_cnt 单调虚增。
// INV-14: baseEventExtraDetail 只允许 recordPromptModelRequestStarted 覆盖模型维度。
//         破坏后果：多处改写会让 send_btn 与 message_completion 的模型口径分裂，无法对账。
// INV-15: 活动 step 的 startedAt 必须 ≤ 其所有事件的 now，且在权限等待回填时同步前移。
//         破坏后果：duration_ms < waiting_ms，工具墙钟耗时小于其中等待时间，自相矛盾。
// ============================================================
import {
  legacyTelemetryModelFields,
  legacyTelemetryModelValue,
  legacyTelemetryProviderId,
} from "@/lib/providerTelemetryIdentity.js";
import type {
  InputId,
  PlanIdentitySnapshot,
  ZCodeContextCompactionTimelineMeta,
  ZCodePersistedFileChange,
  ZCodeProvider,
  ZCodeStreamEvent,
  ZCodeTimelineStatus,
  ZCodeUsage,
} from "@zcode/shared";
import {
  CUSTOM_SUPPLIER_KEY_PREFIX,
  GHOST_SUPPLIER_KEY_PREFIX,
  NATIVE_SUPPLIER_KEY_PREFIX,
  createUuid,
  computeLineChangeStat,
  sanitizeTelemetrySkillName,
  decodeCustomModelValue,
} from "@zcode/shared";
//
// 依赖方向：本文件只依赖 shared 的纯函数与类型，不 import React、store 或服务层。
// 原因有二：遥测入口遍布 UI，一旦引入服务依赖就会形成循环引用；纯函数形态还能在单测里
// 用合成时钟直接驱动，不必启动渲染树。新增依赖前先确认它是否会把浏览器状态带进来。
//
// 每个 workspace 一份「输入开始时间」状态：用户聚焦输入框即开始计时，发送时消费并清零。
// 隐式前提：同一时刻一个 workspace 只有一个 composer。多窗口共享同一 workspacePath 时
// 会互相覆盖，此时输入耗时只能取最后一次聚焦，属于已知取舍。
interface ComposerInputTimingState {
  inputStartTime: number;
  inputFirstCharTime: number;
}

// 一条用户消息的全部可变采集状态，字段分三类，混用会直接导致报表口径错：
// - 身份类（taskId/messageId/inputId）：全程只读，用于关联与去重；
// - 时间类（sendTime/inputStartTime/inputFirstCharTime/firstTokenAt）：只在状态机推进点写入；
// - 累计类（waitingMs/toolCallTotal/toolCallFailed/finalizedAgentStepCount）：只增不减，
//   禁止在终态回扫历史消息重算，否则会重复计数（INV-13）。
//
// usageEventKeys 是「已计入的 token 事件」集合：V4 的 usage 以低频 delta 到达且可能被重放，
// 没有这个集合就无法区分「新 delta」与「重连重放」，token 会被重复累加（INV-4）。
// firstTokenAt 用 null 而不是 0 作哨兵：0 是合法时间戳，会让「未收到首 token」被误判为
// 「已在纪元处收到」，TTFT 直接变成巨大的正数（INV-7）。
//
// baseEventExtraDetail 是发送瞬间的快照拷贝（createPromptTelemetryState 里展开赋值），
// 不是引用共享：否则两个 prompt 会同时改写同一个对象，send_btn 的字段互相污染。
interface PromptTelemetryState {
  taskId: string;
  messageId: string;
  inputId?: InputId;
  baseEventExtraDetail: Record<string, string>;
  sendTime: number;
  inputStartTime: number;
  inputFirstCharTime: number;
  waitingMs: number;
  permissionWaitsByRequestId: Map<string, PermissionWaitState>;
  firstTokenAt: number | null;
  usage: ZCodeUsage | null;
  usageEventKeys: Set<string>;
  finalizedAgentStepCount: number;
  toolCallTotal: number;
  toolCallFailed: number;
  firstToolCallError: string;
}

// permission 等待的起点。toolCallId 可能缺失（老协议只给 requestId），此时用 requestId 兜底，
// 保证 settle 时至少能按 requestId 找到记录，而不是让这段等待永久挂起。
// requestedAt 取「第一次记录」的时间：重复广播由 requestId 去重挡住，不会把起点推后。
interface PermissionWaitState {
  requestedAt: number;
  toolCallId?: string;
}

// 终态入参：finishedAt 由调用方提供而不是内部取 now，是为了让事件时间与流事件时间同一时钟域。
// 若这里自行取值，回放/补发场景会用「处理时间」替代「事件时间」，duration_ms 与数仓时间轴错位。
interface FinalizePromptTelemetryInput {
  taskId: string;
  status: string;
  finishedAt: number;
  fileChanges?: readonly ZCodePersistedFileChange[];
  usage?: ZCodeUsage;
  errorType?: string;
  errorMsg?: string;
  messageSource?: PromptMessageSource;
  agentComposition?: AgentComposition;
}

/** 独立 background wake 轮的来源：Agent 工具的后台子代理，或 dynamic-workflow run 的通知。 */
// 只有 background wake 轮才带 messageSource：它表示「这条消息不是用户直接输入触发」。
// 数仓据此把这些轮次从用户主动会话的转化率分母里剔除；若给普通发送也补值，
// 后台轮的占比会被稀释，反而看不出唤醒是否异常。
// 取值封闭为两个：新增来源必须同时改这里与数仓过滤条件，否则线上会出现未登记的维度值。
export type PromptMessageSource = "background_subagent" | "background_workflow";

/**
 * `message_completion.agent_composition`：本轮消费过哪些 Subagent 结果（fg = 前台、bg = 后台、
 * wf = 动态工作流 run）。八个值 = 三个布尔的组合。
 */
type AgentComposition =
  | "main_only"
  | "main_plus_fg"
  | "main_plus_bg"
  | "main_plus_wf"
  | "main_plus_fg_bg"
  | "main_plus_fg_wf"
  | "main_plus_bg_wf"
  | "main_plus_fg_bg_wf";

export function composeAgentComposition(input: {
  hasForegroundSubagentResult: boolean;
  hasBackgroundSubagentResult: boolean;
  hasWorkflowResult: boolean;
}): AgentComposition {
  // 拼接顺序固定为 fg → bg → wf：枚举的八个字面量是按这个顺序手写的，
  // 调换顺序会得到 "main_plus_bg_fg" 这类不在联合类型里的字符串，运行时只能靠 as 掩盖。
  // [权衡] 用字符串而不是位掩码：数仓需要可读维度值；代价是新增来源必须同时扩枚举与看板映射。
  const parts = [
    ...(input.hasForegroundSubagentResult ? ["fg"] : []),
    ...(input.hasBackgroundSubagentResult ? ["bg"] : []),
    ...(input.hasWorkflowResult ? ["wf"] : []),
  ];
  return parts.length === 0 ? "main_only" : (`main_plus_${parts.join("_")}` as AgentComposition);
}

interface FinalizedPromptTelemetry {
  taskId: string;
  messageId: string;
  eventExtraDetail: Record<string, string>;
}

type AgentStepType = "reasoning" | "tool_call" | "generation";
type GenerationCloseReason = "reasoning" | "tool_call" | "task_complete" | "task_error";
type AgentStepTelemetryClientMode = "desktop-continuous" | "web-remote-replayable";
// AgentStepType 是三态封闭集合：reasoning 与 generation 互斥（同一时刻只有一种主输出），
// tool_call 可以多个并存。新增类型而不更新 close* 系列，该 step 会永久停留在活动索引里。
//
// GenerationCloseReason 记录「是什么事件关闭了正文 step」，它决定 generation_tail_finalize_ms
// 是否有意义：只有 task_complete/task_error 才是真正的「尾包 → 终态」延迟。
//
// clientMode 决定时间基准：desktop-continuous 的 Date.now() 与源端同一时钟域；
// web-remote-replayable 的 now 是本地重放时间，不能用于跨端延迟（INV-12）。
export type AgentStepRole = "foreground subagent" | "background subagent" | "workflow subagent";

// 一个活动 step。startedAt 可能在权限等待回填时被前移（applySettledPermissionWaitAttribution），
// 因此 duration_ms 恒 ≥ waiting_ms；若反过来，说明等待被记到了 step 创建之前（INV-15）。
// lastMessageChunkAt 只对 generation 有意义，用于计算尾包延迟；空值表示「没有正文分片」，
// 与「分片时间恰好为 0」必须区分，因此用可选字段而不是 0。
interface ActiveAgentStep {
  stepId: string;
  stepType: AgentStepType;
  loopIndex: number;
  startedAt: number;
  waitingMs: number;
  model?: AgentStepModelIdentity;
  usage?: AgentStepUsageAttribution;
  lastMessageChunkAt?: number;
  toolId?: string;
  toolName?: string;
  agentId?: string;
  agentRole?: AgentStepRole;
  skillMetadata?: AgentStepSkillMetadata;
  pluginMetadata?: { pluginId: string; component: "mcp" };
}

// skill 归因只接受「已解析」的元数据：name 必须同时带 source 才可信（见 applyAgentStepSkillMetadata）。
// 失败调用（未解析到 skill）不允许用用户输入兜底，否则会把一次失败调用记成成功使用，
// 直接抬高 skill 采纳率。
interface AgentStepSkillMetadata {
  name?: string;
  qualifiedName?: string;
  pluginId?: string;
  source?: "agents" | "zcode" | "bundled" | "plugin" | "remote";
}

interface AgentStepModelIdentity {
  requestId?: string;
  modelName: string;
  modelProvider: string;
  providerName: string;
}

// requestIds 保留明细，用于「单请求 step」回填 model_request_id；requestCount 是聚合口径。
// 两者不能互相推导：合并过多次请求的 step 有 count>1 但 requestIds 可能因去重而更短，
// 用 requestIds.length 当 count 会低估重试次数。
interface AgentStepUsageAttribution {
  requestIds: string[];
  requestCount: number;
  scope: "model_request" | "subagent_requests";
  usage: ZCodeUsage;
}

interface AgentStepToolAttribution {
  agentId?: string;
  agentRole?: AgentStepRole;
  modelName?: string;
  modelProvider?: string;
  providerName?: string;
}

// loopIndex 单调递增且跨 step 类型共享：数仓用它还原一轮对话内的执行顺序。
// 因此它不能按类型各自计数，也不能在 step 关闭时回收。
//
// pendingUsageByRequestId 是「usage 先到、step 后建」的暂存区；它与 step.usage 是二选一关系，
// 同一 requestId 的 usage 不允许同时存在于两处，否则会被消费两次（INV-5）。
//
// settledPermissionWaitsByToolId 承接「工具终态早于 permission 响应」的乱序：
// 等待已结算但 step 已不在索引里，只能暂存到该 toolId 的 step 出现时再补。
interface AgentStepTelemetryState {
  nextLoopIndex: number;
  currentModelRequest: AgentStepModelIdentity | null;
  pendingUsageByRequestId: Map<string, AgentStepUsageAttribution>;
  reasoningStep: ActiveAgentStep | null;
  generationStep: ActiveAgentStep | null;
  toolStepsById: Map<string, ActiveAgentStep>;
  settledPermissionWaitsByToolId: Map<string, SettledPermissionWaitAttribution>;
}

interface SettledPermissionWaitAttribution {
  waitingMs: number;
  earliestRequestedAt: number;
}

interface FinalizedAgentStepTelemetry {
  taskId: string;
  messageId: string;
  eventExtraDetail: Record<string, string>;
}

// 四个进程级 Map 的生命周期由 taskId / workspacePath 决定，没有 TTL：
// 依赖「每个 task 都必然收到终态事件」这一前提。若上游漏发终态，条目会驻留到进程退出，
// 所以额外的 discard* 入口是资源兜底，不是可选优化。
//
// [并发] 全部读写都发生在 UI 主线程的事件回调里，因此不加锁。
// 隐式前提：这些函数不得在 worker 中调用。一旦引入并发，Map 的 check-then-act
// （get → 修改 → set）会丢更新，例如同一 permission 被并发 settle 两次（INV-6）。
const composerInputTimingByWorkspace = new Map<string, ComposerInputTimingState>();
const queuedPromptTelemetryByTask = new Map<string, PromptTelemetryState[]>();
const activePromptTelemetryByTask = new Map<string, PromptTelemetryState>();
const agentStepTelemetryByTask = new Map<string, AgentStepTelemetryState>();

// provider 维度有三个可能来源，优先级固定：model value 自带的 provider > supplier key 前缀 > 当前 provider。
// 反过来（先看 selectedSupplierKey）会出现 `uuid/model` 搭配旧 supplier 的错配，
// 这正是下面 Bugfix 注释描述的现象。所以只要 model value 能解析出 provider，就必须立即返回，
// 不能再被 supplier key 覆盖。
function resolvePromptTelemetryModelProvider(params: {
  modelName?: string | null;
  provider?: ZCodeProvider;
  selectedSupplierKey?: string | null;
}): string {
  const { modelName, provider, selectedSupplierKey } = params;
  // Bugfix: send_btn 的 model_name 已按 UI model value 修正，但 selectedSupplierKey
  // 偶尔仍停留在上一个 supplier，导致出现 `uuid/model` 搭配 `glm` provider。
  // 当 model value 自身带 provider 维度时，provider 必须与同一份 UI selection 对齐。
  const providerFromModelName = readProviderIdFromModelValue(modelName);
  if (providerFromModelName) {
    return providerFromModelName;
  }

  if (!selectedSupplierKey) {
    return provider ?? "";
  }

  // custom / ghost / native 三种前缀是 supplier key 的封闭集合：未知前缀一律回退到当前 provider，
  // 而不是把整串 key 当 provider 上报，避免数仓出现只用一次就消失的脏维度。
  // 每种前缀都先 trim 再判空：key 形如 "custom:" 时不能把空串当 provider 返回。
  if (selectedSupplierKey.startsWith(CUSTOM_SUPPLIER_KEY_PREFIX)) {
    const customProviderId = selectedSupplierKey.slice(CUSTOM_SUPPLIER_KEY_PREFIX.length).trim();
    return customProviderId || provider || "";
  }

  // ghost supplier 代表尚未解析到稳定 custom provider 的临时隔离态，provider 维度统一回退到当前 ZCode Agent provider。
  if (selectedSupplierKey.startsWith(GHOST_SUPPLIER_KEY_PREFIX)) {
    return provider ?? "";
  }

  if (selectedSupplierKey.startsWith(NATIVE_SUPPLIER_KEY_PREFIX)) {
    const nativeProvider = selectedSupplierKey.slice(NATIVE_SUPPLIER_KEY_PREFIX.length).trim();
    return nativeProvider || provider || "";
  }

  return provider ?? "";
}

// custom model value 是编码后的结构，必须优先解码：它的 providerId 比「按 / 切分」更权威。
// 因为 uuid 形态的 model value 里同样含 `/`，直接切分会把 uuid 段误当成 provider id，
// 数仓里就会多出一个以 uuid 为名的 provider 维度。
// 返回值统一 trim 后判空：空串一律视为「无法解析」，交给上层回退，不能返回 "" 让调用方误以为成功。
function readProviderIdFromModelValue(modelValue: string | null | undefined): string | null {
  const normalizedModelValue = modelValue?.trim() ?? "";
  if (!normalizedModelValue) {
    return null;
  }

  // 解码优先：custom 编码里同时携带 providerId 与 modelId，是最完整的来源。
  // 只有 providerId 非空才采纳；空串视为未编码，继续走后面的 `/` 切分。
  const customModel = decodeCustomModelValue(normalizedModelValue);
  if (customModel?.providerId?.trim()) {
    return customModel.providerId.trim();
  }

  // separatorIndex <= 0 时返回 null：等于 0 说明 model value 以 `/` 开头（provider 为空），
  // 小于 0 说明根本没有分隔符。这两种情况都不可解析，不能把空串当 provider 返回。
  const separatorIndex = normalizedModelValue.indexOf("/");
  if (separatorIndex <= 0) {
    return null;
  }

  const providerId = normalizedModelValue.slice(0, separatorIndex).trim();
  return providerId || null;
}

// [失败路径] baseURL 是用户可配置的自由文本，new URL 可能抛错；这里捕获后返回空串而不是向上抛。
// 理由：provider_name 只是展示维度，让一个畸形 URL 阻断整条 send_btn 遥测不值得。
// [权衡] 只取 hostname，不上报完整 URL：完整 URL 可能带 query（token）与内网路径，
// 属于 INV-11 划定的敏感边界之外。
function resolveProviderHostname(baseURL: string | null | undefined): string {
  const normalizedBaseURL = baseURL?.trim() ?? "";
  if (!normalizedBaseURL) {
    return "";
  }

  try {
    return new URL(normalizedBaseURL).hostname;
  } catch {
    return "";
  }
}

// nextLoopIndex 从 1 开始：0 留给「无法确定轮次」的历史数据，避免新数据与兜底值混淆。
function createAgentStepTelemetryState(): AgentStepTelemetryState {
  // 每个容器都独立 new：state 之间不能共享 Map，否则两个 task 的 usage 去重、
  // 权限暂存会互相可见，出现「A 的 usage 被 B 消费」这类跨消息串扰。
  return {
    nextLoopIndex: 1,
    currentModelRequest: null,
    pendingUsageByRequestId: new Map(),
    reasoningStep: null,
    generationStep: null,
    toolStepsById: new Map(),
    settledPermissionWaitsByToolId: new Map(),
  };
}

// 懒创建而不是在 activate 时统一创建：background subagent 会复用同一 task 的 step 状态，
// 若在别处提前创建，会出现两份 state 各自分配 loopIndex，序号交错。
// 这里的 get-or-create 之所以安全，依赖单线程前提（见文件头部 Map 的并发说明）。
function getAgentStepTelemetryState(taskId: string): AgentStepTelemetryState {
  const existing = agentStepTelemetryByTask.get(taskId);
  if (existing) {
    return existing;
  }

  const created = createAgentStepTelemetryState();
  agentStepTelemetryByTask.set(taskId, created);
  return created;
}

// stepId 用 UUID 而不是自增序号：同一 task 的 state 会被删除重建（终态之后），
// 自增序号在重建后会重复，数仓按 step_id 去重就会静默丢数据（INV-2）。
// nextLoopIndex 在创建时自增而不是 close 时：即使 step 因异常未被收口，
// 序号也已经消耗，不会与后续 step 撞号。
function createAgentStep(
  state: AgentStepTelemetryState,
  stepType: AgentStepType,
  startedAt: number,
  options: {
    toolId?: string;
    toolName?: string;
    skillMetadata?: AgentStepSkillMetadata;
  } = {},
): ActiveAgentStep {
  const step: ActiveAgentStep = {
    stepId: createUuid(),
    stepType,
    loopIndex: state.nextLoopIndex,
    startedAt,
    waitingMs: 0,
    ...(state.currentModelRequest ? { model: { ...state.currentModelRequest } } : {}),
    ...options,
  };
  const requestId = step.model?.requestId;
  if (requestId) {
    // [权衡] 消费即删除：同一个 request 的 usage 只能归属一个 step。
    // 若保留给后续 step 复用，紧跟着创建的工具 step 就会拿到主模型的 token（INV-5）。
    // 这里按 requestId 精确匹配而不是「取最早一条」，保证归因对象是产生 token 的那次请求。
    const pendingUsage = state.pendingUsageByRequestId.get(requestId);
    if (pendingUsage) {
      step.usage = pendingUsage;
      state.pendingUsageByRequestId.delete(requestId);
    }
  }
  state.nextLoopIndex += 1;
  return step;
}

// 状态归一必须收敛到三个值：数仓按 status 做成功率聚合，未收敛的自由文本会让「失败」
// 摊薄到多个取值上，成功率虚高。denied 归入 fail 而不是单独取值：权限拒绝对用户语义
// 就是本轮失败；timeout 单独保留，因为它对应另一条重试/超时链路。
// 未知取值一律落到 success：这是既有口径，改成 fail 会让新增状态码把成功率打成 0。
function normalizeAgentStepStatus(status: string): string {
  if (status === "failed" || status === "fail" || status === "denied") {
    return "fail";
  }
  if (status === "timeout") {
    return "timeout";
  }
  return "success";
}

// [失败路径] content 来自工具返回，可能不是 JSON 字符串；解析失败返回 undefined，
// 让 agent_step 少一个维度，而不是让整条事件丢失。
// 只取 automation.automationId：CronCreate 返回结构里的其他字段可能包含用户任务正文，
// 不在 INV-11 允许上报的标识类字段范围内。
function cronCreateAutomationId(content: unknown): string | undefined {
  let value = content;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const automation = (value as { automation?: unknown }).automation;
  if (!automation || typeof automation !== "object" || Array.isArray(automation)) return undefined;
  const automationId = (automation as { automationId?: unknown }).automationId;
  return typeof automationId === "string" && automationId.trim() ? automationId.trim() : undefined;
}

// 幂等写入：TTFT 只认第一次 token（INV-7）。这里不做「取 min」的时间修正，
// 因为事件到达顺序即真实顺序；取 min 反而会把乱序重放的更早时间当成首 token，
// 让 TTFT 变成负数或异常小值。
function markPromptFirstToken(prompt: PromptTelemetryState, now: number): void {
  if (prompt.firstTokenAt !== null) {
    return;
  }

  prompt.firstTokenAt = now;
}

// 把一个活动 step 冻结成不可变的上报负载。调用方只决定「何时收口」，字段口径全部收在这里，
// 保证 reasoning / generation / tool_call 三类 step 的列集合一致：数仓按列解析，
// 缺列会被当成 null，而 null 与 0 在聚合里语义不同（前者被过滤，后者参与均值）。
function finalizeAgentStep(input: {
  prompt: PromptTelemetryState;
  step: ActiveAgentStep;
  finishedAt: number;
  status: string;
  errorType?: string;
  errorMsg?: string;
  generationTailFinalizeMs?: number;
  automationId?: string;
}): FinalizedAgentStepTelemetry {
  const normalizedStatus = normalizeAgentStepStatus(input.status);
  const isToolCall = input.step.stepType === "tool_call";
  const usage = input.step.usage?.usage;
  const model = input.step.model;
  // Bugfix：completion 之前扫描整个 taskMessages，导致后一轮把历史 step/tool
  // 重复计入。逐 step 收口才是当前 message 的事实源，因此聚合必须在这里同步累计。
  // [事务] 累计必须先于 return 完成：成功后 step 就从活动索引删除，
  // 这里是唯一还能看到它的事实源；若把累加放到调用方，异常路径会漏计（INV-13）。
  input.prompt.finalizedAgentStepCount += 1;
  if (isToolCall) {
    input.prompt.toolCallTotal += 1;
    // errorMsg 也算失败信号：部分工具（例如 bash 非零退出）通过 content 报错但 status 仍是
    // completed，只看 status 会把它们记成成功。firstToolCallError 只取第一条，避免长错误串
    // 把 extraDetail 撑爆。
    const isFailed = normalizedStatus !== "success" || Boolean(input.errorMsg);
    if (isFailed) {
      input.prompt.toolCallFailed += 1;
      if (!input.prompt.firstToolCallError && input.errorMsg) {
        input.prompt.firstToolCallError = input.errorMsg;
      }
    }
  }

  // 时间与用量统一转成字符串：数仓的 extraDetail 是 string→string 映射。
  // 直接传 number 会被隐式 toString，但 null/undefined 会变成 "null"/"undefined" 污染维度，
  // 所以每个数值字段都显式给默认值（?? 0 或 ""），宁可少一个维度也不产生脏值。
  return {
    taskId: input.prompt.taskId,
    messageId: input.prompt.messageId,
    eventExtraDetail: {
      step_id: input.step.stepId,
      is_tftt_cached: "0",
      loop_index: String(input.step.loopIndex),
      step_type: input.step.stepType,
      // Bug 根因：旧实现从 prompt 共享字段取模型，后续主请求或 child 请求会覆盖已创建 step。
      // step 必须冻结其真实请求模型；只有旧事实缺少 request identity 时才回退 prompt seed。
      model_name: legacyTelemetryModelValue(
        model?.modelName ?? input.prompt.baseEventExtraDetail.model_name ?? "",
      ),
      model_provider: legacyTelemetryProviderId(
        model?.modelProvider ?? input.prompt.baseEventExtraDetail.model_provider ?? "",
      ),
      provider_name: model?.providerName ?? input.prompt.baseEventExtraDetail.provider_name ?? "",
      // requestIds 只有恰好 1 个时才能落到 model_request_id：合并了多次请求的 step 没有唯一 id，
      // 强行取第一个会让数仓把这多个请求的 token 全算到那一个 request 上，归因反而更错。
      model_request_id:
        input.step.usage?.requestIds.length === 1 ? (input.step.usage.requestIds[0] ?? "") : "",
      model_request_count: String(input.step.usage?.requestCount ?? 0),
      token_usage_scope: input.step.usage?.scope ?? "",
      is_tool_call: isToolCall ? "1" : "0",
      tool_name: input.step.toolName ?? "",
      tool_call_id: isToolCall ? (input.step.toolId ?? "") : "",
      ...(input.step.agentId ? { agent_id: input.step.agentId } : {}),
      ...(input.step.agentRole ? { agent_role: input.step.agentRole } : {}),
      duration_ms: String(Math.max(input.finishedAt - input.step.startedAt, 0)),
      waiting_ms: String(input.step.waitingMs),
      generation_tail_finalize_ms:
        input.generationTailFinalizeMs !== undefined ? String(input.generationTailFinalizeMs) : "",
      status: normalizedStatus,
      input_tokens: String(usage?.inputTokens ?? 0),
      output_tokens: String(usage?.outputTokens ?? 0),
      reasoning_tokens: String(usage?.reasoningTokens ?? 0),
      cached_tokens: String(usage?.cachedInputTokens ?? 0),
      cache_write_input_tokens: String(usage?.cachedWriteInputTokens ?? 0),
      total_tokens: String(usage?.totalTokens ?? 0),
      // 成功态必须清空 error_type / error_msg：step 结构可能被复用于同一轮的多条事件，
      // 残留的旧错误会让数仓（以 error_type 非空判失败）把成功 step 记成失败，成功率被低估。
      error_type: normalizedStatus === "success" ? "" : (input.errorType ?? "UNKNOWN"),
      error_msg: normalizedStatus === "success" ? "" : (input.errorMsg ?? ""),
      ...(input.automationId ? { automation_id: input.automationId } : {}),
      ...(isToolCall && (input.step.pluginMetadata?.pluginId || input.step.skillMetadata?.pluginId)
        ? {
            plugin_id: input.step.pluginMetadata?.pluginId ?? input.step.skillMetadata!.pluginId!,
            plugin_component: input.step.pluginMetadata?.component ?? "skill",
          }
        : {}),
      // plugin / skill 维度只在 tool step 上出现：正文 step 携带这些字段会让按 step_type
      // 聚合的看板出现「非工具步骤也带插件」的脏组合，也无法与工具调用数对账。
      ...(isToolCall && input.step.toolName === "Skill"
        ? { skill_name: sanitizeTelemetrySkillName(input.step.skillMetadata?.name) }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.qualifiedName
        ? { skill_qualified_name: input.step.skillMetadata.qualifiedName }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.pluginId
        ? { skill_plugin_id: input.step.skillMetadata.pluginId }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.source
        ? { skill_source: input.step.skillMetadata.source }
        : {}),
    },
  };
}

// reasoning step 只能被「正文 / 工具 / 终态」关闭，且 status 恒为 success：
// 思考过程本身没有失败语义，失败由后续 generation/tool step 或 task_error 表达。
// 关闭后置 null 而不是打 finished 标记：活动索引里不允许存在已收口 step，
// 否则 createAgentStep 前的「是否已存在」判断会永远为真，后续思考被吞掉。
function closeReasoningStep(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  output: FinalizedAgentStepTelemetry[],
): void {
  if (!state.reasoningStep) {
    return;
  }

  output.push(
    finalizeAgentStep({
      prompt,
      step: state.reasoningStep,
      finishedAt: now,
      status: "success",
    }),
  );
  state.reasoningStep = null;
}

// [时序] 尾包延迟只在「终态关闭」且拿到 lastMessageChunkAt 时才有定义：
// 被 reasoning/tool_call 打断时关闭，说明正文没有走到自然结束，该指标无意义。
// 若对打断也计算，会把「模型转去调用工具」的思考间隔当成尾延迟，P99 被虚高。
// 关闭后立即置 null（INV-2 的推论）：残留会让下一段正文复用旧 startedAt，duration 跨轮累加。
function closeGenerationStep(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  status: string,
  output: FinalizedAgentStepTelemetry[],
  error?: { type?: string; msg?: string },
  closeReason?: GenerationCloseReason,
  clientMode: AgentStepTelemetryClientMode = "desktop-continuous",
): void {
  if (!state.generationStep) {
    return;
  }

  // 修复原因：replayable 恢复会把历史 chunk/terminal 在客户端重放，
  // Date.now() 只能代表本地处理时间，不能代表源端正文尾包到终态的真实尾延迟。
  const canReportGenerationTailFinalize = clientMode === "desktop-continuous";
  const generationTailFinalizeMs =
    canReportGenerationTailFinalize &&
    (closeReason === "task_complete" || closeReason === "task_error") &&
    state.generationStep.lastMessageChunkAt !== undefined
      ? Math.max(now - state.generationStep.lastMessageChunkAt, 0)
      : undefined;

  output.push(
    finalizeAgentStep({
      prompt,
      step: state.generationStep,
      finishedAt: now,
      status,
      errorType: error?.type,
      errorMsg: error?.msg,
      generationTailFinalizeMs,
    }),
  );
  state.generationStep = null;
}

// [事务] 结算顺序固定：先算等待时长并累加到 prompt，再尝试归到 tool step，最后删除记录。
// 若先删除再算，异常中断会让这段等待永久丢失；若归因早于累加，归因失败时无法重试。
// 删除本身是幂等屏障：重复 settle 时第二次 get 不到，直接返回（INV-6）。
function settlePermissionWait(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState | undefined,
  requestId: string,
  now: number,
): void {
  const permissionWait = prompt.permissionWaitsByRequestId.get(requestId);
  if (!permissionWait) {
    return;
  }

  const waitingMs = Math.max(now - permissionWait.requestedAt, 0);
  prompt.waitingMs += waitingMs;
  // 三条归属路径按「step 是否还在」分流：活动 step 直接累加；step 已关闭则暂存到
  // settledPermissionWaitsByToolId，等乱序的 step 出现时补（见 applySettledPermissionWaitAttribution）；
  // 没有 state（消息级结算）时只累加到 prompt 总量，不再往下分。
  // 缺一不可：任何一条漏掉，都会让 prompt.waiting_ms 与各 step.waiting_ms 之和对不上。
  if (permissionWait.toolCallId) {
    const toolStep = state?.toolStepsById.get(permissionWait.toolCallId);
    if (toolStep) {
      toolStep.waitingMs += waitingMs;
    } else if (state) {
      const settled = state.settledPermissionWaitsByToolId.get(permissionWait.toolCallId);
      state.settledPermissionWaitsByToolId.set(permissionWait.toolCallId, {
        waitingMs: (settled?.waitingMs ?? 0) + waitingMs,
        earliestRequestedAt: Math.min(
          settled?.earliestRequestedAt ?? permissionWait.requestedAt,
          permissionWait.requestedAt,
        ),
      });
    }
  }
  prompt.permissionWaitsByRequestId.delete(requestId);
}

// [时序] 回填时必须同时前移 startedAt：等待发生在 step 创建之前，只加 waitingMs 会让
// duration_ms < waiting_ms（INV-15）。取 min 而不是赋值，是因为同一工具可能有多段等待，
// 第一段已经把 startedAt 前移过，覆盖会把更早的起点丢掉。
function applySettledPermissionWaitAttribution(
  state: AgentStepTelemetryState,
  step: ActiveAgentStep,
): void {
  if (!step.toolId) {
    return;
  }

  const settled = state.settledPermissionWaitsByToolId.get(step.toolId);
  if (!settled) {
    return;
  }

  step.waitingMs += settled.waitingMs;
  step.startedAt = Math.min(step.startedAt, settled.earliestRequestedAt);
  state.settledPermissionWaitsByToolId.delete(step.toolId);
}

// 取「已收口等待」与「仍开放等待」的最早时间：乱序链路下两者可能同时存在，
// 只取其一会让 startedAt 晚于真实等待开始时间，duration 反而小于 waiting_ms。
// 返回 undefined 时调用方用 now 兜底，表示「没有任何权限等待记录」。
function findEarliestPermissionRequestedAt(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  toolCallId: string,
): number | undefined {
  let earliest = state.settledPermissionWaitsByToolId.get(toolCallId)?.earliestRequestedAt;
  for (const permissionWait of prompt.permissionWaitsByRequestId.values()) {
    if (permissionWait.toolCallId !== toolCallId) {
      continue;
    }
    earliest = Math.min(earliest ?? permissionWait.requestedAt, permissionWait.requestedAt);
  }
  return earliest;
}

// 按 toolCallId 结算该工具的所有开放等待：一个工具可能先后弹出多次权限确认
// （例如同一命令被不同规则拦截），必须全部结算，否则剩余等待会挂到消息级总量上。
function settlePermissionWaitsForTool(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  toolCallId: string,
  now: number,
): void {
  for (const [requestId, permissionWait] of prompt.permissionWaitsByRequestId) {
    if (permissionWait.toolCallId === toolCallId) {
      settlePermissionWait(prompt, state, requestId, now);
    }
  }
}

// 遍历 keys 快照后再逐个删除：settlePermissionWait 会在循环体内 delete 条目，
// 直接 for...of values() 边遍历边删虽然当前可行，但语义依赖 Map 迭代器实现细节，
// 先取 keys 让「删除」与「遍历」解耦，避免后续重构引入漏项。
function settleAllPermissionWaits(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState | undefined,
  now: number,
): void {
  for (const requestId of prompt.permissionWaitsByRequestId.keys()) {
    settlePermissionWait(prompt, state, requestId, now);
  }
}

// 工具 step 按索引顺序批量关闭：同一 task 内可能有并行工具，顺序不影响聚合，
// 但必须先结算该工具的权限等待，否则这段时间只进 prompt 总量、没有工具维度，
// 「工具耗时 - 等待」会算出负的执行时间。
function closeToolSteps(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  status: string,
  output: FinalizedAgentStepTelemetry[],
  error?: { type?: string; msg?: string },
): void {
  for (const [toolId, toolStep] of state.toolStepsById) {
    settlePermissionWaitsForTool(prompt, state, toolId, now);
    output.push(
      finalizeAgentStep({
        prompt,
        step: toolStep,
        finishedAt: now,
        status,
        errorType: error?.type,
        errorMsg: error?.msg,
      }),
    );
  }
  state.toolStepsById.clear();
}

// send_btn 的上报口径：这里只放「发送瞬间」的稳定事实。
// 模型维度后续可能被 request_started 覆盖（见 recordPromptModelRequestStarted），
// 因此调用方不能缓存这个返回值用于终态上报，否则会与 message_completion 冲突（INV-14）。
// 返回值同时被 queuePromptTelemetry 拷进 baseEventExtraDetail，作为终态的兜底维度。
export function buildPromptTelemetryExtraDetail(params: {
  askMode?: string | null;
  modelName?: string | null;
  provider?: ZCodeProvider;
  selectedSupplierKey?: string | null;
  providerBaseURL?: string | null;
  planIdentitySnapshot?: PlanIdentitySnapshot | null;
}): Record<string, string> {
  const modelProvider = resolvePromptTelemetryModelProvider({
    modelName: params.modelName,
    provider: params.provider,
    selectedSupplierKey: params.selectedSupplierKey,
  });
  const providerHostname = resolveProviderHostname(params.providerBaseURL);

  // provider_name 与 model_provider 是两列不同口径：前者是 hostname（人可读、用于排查后端），
  // 后者是稳定 id（可 join 供应商表）。不要为了「看起来一致」把两者写成同一个值，
  // 否则自定义供应商的 hostname 会污染 provider id 维度。
  return {
    ask_mode: params.askMode ?? "",
    model_name: legacyTelemetryModelValue(params.modelName ?? ""),
    model_provider: legacyTelemetryProviderId(modelProvider),
    // 修复原因：custom provider 的 model_provider 经常是内部 uuid，数仓分析真实后端时没有意义。
    // provider_name 当前承载 provider hostname；不改 model_provider，避免影响既有 uuid/provider id 数仓口径。
    // 这里只从 URL 解析 hostname，不上报完整 endpoint，避免泄漏路径或 query。
    ...(providerHostname ? { provider_name: providerHostname } : {}),
    // agent 字段取 ZCode Agent provider；本仓库没有独立 session.agentId。
    agent: params.provider ?? "",
    plan_status: params.planIdentitySnapshot?.planStatus ?? "unknown",
    plan_product_id: params.planIdentitySnapshot?.planProductId ?? "",
  };
}

const COMPACTION_TERMINAL_STATUSES: readonly ZCodeTimelineStatus[] = [
  // 这份清单是「是否上报」的白名单：新增终态（例如 canceled）必须同时加进来，
  // 否则该终态会一直返回 null，压缩事件永远不落库。
  // interrupted 必须算终态：它已经停止产生压缩事件，不收口就永远缺一次压缩记录。
  "completed",
  "failed",
  "interrupted",
];

function isCompactionTerminalStatus(status: ZCodeTimelineStatus): boolean {
  return COMPACTION_TERMINAL_STATUSES.includes(status);
}

/**
 * 构建压缩（context compaction）结果埋点字段。
 * 仅在终态（completed/failed/interrupted）返回字段对象，运行态（started/retrying/skipped）返回 null，
 * 调用方据此决定是否上报。成功率由数仓按 status 聚合：completed / (completed + failed + interrupted)。
 * provider/model 维度复用 buildPromptTelemetryExtraDetail，version 由后端 reportEvent 注入。
 */
// [权衡] 运行态（started/retrying/skipped）返回 null 而不是返回带 status 的对象：
// 调用方以 null 作为「不该上报」的唯一信号；若返回对象，运行态会被误当成一次完整的压缩事件，
// 让压缩次数与成功率都失真。新增终态时必须先加进 COMPACTION_TERMINAL_STATUSES。
// [失败路径] 缺 token 数据时留空串而不是 "0"：0 会参与均值计算并把压缩率拉向 0，
// 空串在数仓侧等价于 NULL，不进入分母。
export function buildCompactionTelemetryExtraDetail(params: {
  timeline: ZCodeContextCompactionTimelineMeta;
  provider?: ZCodeProvider;
  /** V4 fact 已从真实模型请求归一化出的 provider；优先于旧 UI supplier 推导。 */
  modelProvider?: string | null;
  modelName?: string | null;
  selectedSupplierKey?: string | null;
}): Record<string, string> | null {
  const { timeline } = params;
  // 早退发生在任何字段拼装之前：运行态没有可靠的 endedAt/压缩后 token 数，
  // 提前构造字段只会得到一版「看起来完整、实际全是默认值」的假事件。
  if (!isCompactionTerminalStatus(timeline.status)) {
    return null;
  }

  // 没有 provider 对象时只留 model_name、provider 置空：拿不到供应商就宁缺勿错，
  // 用 selectedSupplierKey 瞎猜会让自定义供应商的压缩事件挂到 builtin 维度上。
  const modelFields = params.provider
    ? buildPromptTelemetryExtraDetail({
        modelName: params.modelName,
        provider: params.provider,
        selectedSupplierKey: params.selectedSupplierKey,
      })
    : { model_name: params.modelName ?? "", model_provider: "" };

  const preCompactTokens = timeline.preCompactTokenCount ?? 0;
  const postCompactTokens = timeline.postCompactTokenCount ?? 0;
  // 压缩率用供应商口径 post/pre；pre 为 0（缺数据）时留空，避免除零污染分布。
  const compactRatio =
    preCompactTokens > 0 ? (postCompactTokens / preCompactTokens).toFixed(4) : "";
  // 只有 startedAt/endedAt 都存在才算时长；缺失时留空，避免用当前时间补出一个虚假的短时长
  // ——那会让压缩耗时分布出现一个集中在 0 附近的伪峰。
  const durationMs =
    timeline.startedAt !== undefined && timeline.endedAt !== undefined
      ? String(Math.max(timeline.endedAt - timeline.startedAt, 0))
      : "";

  return {
    status: timeline.status,
    trigger: timeline.trigger,
    reason: timeline.reason ?? "",
    attempt: String(timeline.attempt ?? 0),
    duration_ms: durationMs,
    pre_compact_tokens: String(preCompactTokens),
    post_compact_tokens: String(postCompactTokens),
    true_post_compact_tokens: String(timeline.truePostCompactTokenCount ?? 0),
    compact_ratio: compactRatio,
    model_name: legacyTelemetryModelValue(modelFields.model_name ?? ""),
    model_provider: legacyTelemetryProviderId(
      params.modelProvider?.trim() || modelFields.model_provider || "",
    ),
  };
}

// 成功态也显式补 tool_use_prompt_tokens=0：数仓按固定列集合建表，
// 缺列会被过滤掉，导致「有该列」与「无该列」的消息落在不同分母里。
// 这是唯一一个不来自 usage 的字段，因此不能改成「有则上报」，否则列会时有时无。
function buildPromptUsageTelemetryExtraDetail(
  usage: ZCodeUsage | undefined,
  tokenSource?: string,
): Record<string, string> {
  if (!usage) {
    return {};
  }

  return {
    input_tokens: String(usage.inputTokens),
    output_tokens: String(usage.outputTokens),
    // 可空计数用 ?? 0 而不是留空：这些列是「加总类」，缺列会让 sum 与 count 的分母不一致，
    // 与 tool_use_prompt_tokens 的「必填 0」不同，它们缺失时在语义上确实就是 0。
    reasoning_tokens: String(usage.reasoningTokens ?? 0),
    cached_input_tokens: String(usage.cachedInputTokens ?? 0),
    cache_write_input_tokens: String(usage.cachedWriteInputTokens ?? 0),
    // ZCode Agent 链路未透出 tool use prompt token，成功态显式补 0 保持 extraDetail 字段集合完整。
    tool_use_prompt_tokens: "0",
    total_tokens: String(usage.totalTokens),
    ...(tokenSource ? { token_source: tokenSource } : {}),
  };
}

// 累加而不是覆盖：一次 prompt 可能包含多次模型请求（正文 + 子代理 + 重试）。
// 可空字段统一 ?? 0：老数据没有这些列，缺失即视为 0，不能把 undefined 传播下去
// ——undefined 参与加法会得到 NaN，而 NaN 会被序列化成 null，最终污染整行统计。
function mergePromptUsage(left: ZCodeUsage | null, right: ZCodeUsage): ZCodeUsage {
  // left 为空表示这是本次 prompt 的第一个 usage 事件：直接拷贝 right，但要补齐可空字段，
  // 让返回类型始终满足 ZCodeUsage；否则后续累加会在第一项上碰到 undefined。
  if (!left) {
    return {
      inputTokens: right.inputTokens,
      outputTokens: right.outputTokens,
      totalTokens: right.totalTokens,
      reasoningTokens: right.reasoningTokens ?? 0,
      cachedInputTokens: right.cachedInputTokens ?? 0,
      cachedWriteInputTokens: right.cachedWriteInputTokens ?? 0,
    };
  }

  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    cachedWriteInputTokens:
      (left.cachedWriteInputTokens ?? 0) + (right.cachedWriteInputTokens ?? 0),
  };
}

// 输入计时是「每 workspace 一份」的瞬时状态，与 prompt 生命周期解耦：
// 用户可能聚焦后不发送就切走，因此这里不绑定 taskId，也不在 prompt 终态清理。
// 惰性创建而不是预先分配：绝大多数 workspace 从未输入，提前分配会随窗口数量线性增长内存。
function ensureComposerInputTiming(workspacePath: string): ComposerInputTimingState {
  // 两个时间都用 0 作为「未发生」哨兵，而不是 null：这里与 firstTokenAt 不同，
  // 输入计时只做减法且在 focus 时立即覆盖，0 不会与合法值混淆，反而省掉分支。
  const existing = composerInputTimingByWorkspace.get(workspacePath);
  if (existing) {
    return existing;
  }

  const created: ComposerInputTimingState = {
    inputStartTime: 0,
    inputFirstCharTime: 0,
  };
  composerInputTimingByWorkspace.set(workspacePath, created);
  return created;
}

// 消费即清零：一次输入只对应一次发送。若不清零，第二次发送会继承第一次的起始时间，
// input_start_time 早于实际输入开始，输入耗时被系统性高估。
// [权衡] 缺失时用 sendTime 兜底而不是丢弃字段：数仓需要稳定的时间基准，
// 缺字段会让这批消息在按耗时聚合时整行被排除。
function consumeComposerInputTiming(workspacePath: string, sendTime: number) {
  const current = ensureComposerInputTiming(workspacePath);
  const inputStartTime = current.inputStartTime || current.inputFirstCharTime || sendTime;
  const inputFirstCharTime = current.inputFirstCharTime || inputStartTime || sendTime;

  composerInputTimingByWorkspace.set(workspacePath, {
    inputStartTime: 0,
    inputFirstCharTime: 0,
  });

  return {
    inputStartTime,
    inputFirstCharTime,
  };
}

// 同一路径可能被多轮 turn 多次修改：只保留第一次的 beforeContent 与最后一次的 afterContent，
// 才能得到「整条消息的净变更」。若逐轮累加，删除再新建会被算成两倍新增行，
// 而先建后删会被算成正数（实际净变化为 0）。
// [资源] 只保留计数、不留快照引用：文件内容可能很大，Map 一旦持有会让整条消息的内容常驻内存。
function collectFileChangeMetrics(fileChanges: readonly ZCodePersistedFileChange[] | undefined) {
  if (!fileChanges || fileChanges.length === 0) {
    return {
      changedFileCount: 0,
      generatedCodeLines: 0,
    };
  }

  const changedFileMap = new Map<string, { beforeContent: string | null; afterContent: string }>();

  for (const turn of fileChanges) {
    for (const snapshot of turn.snapshots) {
      const existing = changedFileMap.get(snapshot.path);
      if (existing) {
        existing.afterContent = snapshot.afterContent;
      } else {
        changedFileMap.set(snapshot.path, {
          beforeContent: snapshot.beforeContent,
          afterContent: snapshot.afterContent,
        });
      }
    }
  }

  let generatedCodeLines = 0;
  for (const file of changedFileMap.values()) {
    generatedCodeLines += computeLineChangeStat(file.beforeContent, file.afterContent).added;
  }

  return {
    changedFileCount: changedFileMap.size,
    generatedCodeLines,
  };
}

// 聚焦即重置「首字符时间」：同一 workspace 多次聚焦时，以最后一次聚焦为输入起点，
// 否则用户中途离开再回来，输入耗时会从第一次聚焦算起，无限放大。
// inputFirstCharTime 置 0 而不是保留：首字符一定发生在本次聚焦之后。
export function recordComposerFocus(workspacePath: string, now = Date.now()): void {
  const inputTiming = ensureComposerInputTiming(workspacePath);
  inputTiming.inputStartTime = now;
  inputTiming.inputFirstCharTime = 0;
}

export function recordComposerTextChange(
  workspacePath: string,
  nextText: string,
  now = Date.now(),
): void {
  // 删除到空串不算「开始输入」：用户清空草稿后重新输入，首字符时间应重新起算，
  // 否则会把「清空 → 思考 → 重输」的间隔算进输入耗时。
  if (nextText.length === 0) {
    return;
  }

  const inputTiming = ensureComposerInputTiming(workspacePath);
  // 只记第一次：输入耗时关心「开始打字」的瞬间，后续每次按键都覆盖会把耗时压到接近 0。
  if (inputTiming.inputFirstCharTime !== 0) {
    return;
  }

  inputTiming.inputFirstCharTime = now;
  if (inputTiming.inputStartTime === 0) {
    inputTiming.inputStartTime = now;
  }
}

// 每个字段都显式初始化：新增字段若忘了初始化，TypeScript 会报错；但更重要的是
// 所有可变容器必须新建实例，不能复用入参对象，否则两条消息会共享同一个 Map/Set，
// 一条消息的 permission 等待或 usage 去重会顺手影响另一条。
function createPromptTelemetryState(input: {
  taskId: string;
  messageId: string;
  inputId?: InputId;
  sendTime: number;
  inputStartTime: number;
  inputFirstCharTime: number;
  extraDetail?: Record<string, string>;
}): PromptTelemetryState {
  return {
    taskId: input.taskId,
    messageId: input.messageId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    baseEventExtraDetail: input.extraDetail ? { ...input.extraDetail } : {},
    sendTime: input.sendTime,
    inputStartTime: input.inputStartTime,
    inputFirstCharTime: input.inputFirstCharTime,
    waitingMs: 0,
    permissionWaitsByRequestId: new Map(),
    firstTokenAt: null,
    usage: null,
    usageEventKeys: new Set(),
    finalizedAgentStepCount: 0,
    toolCallTotal: 0,
    toolCallFailed: 0,
    firstToolCallError: "",
  };
}

// 排队即开始计时：队列允许同一 task 有多条待激活消息（用户连续发送），因此用数组而不是单值。
// 激活时按 messageId 精确摘除，既支持 FIFO 之外的乱序激活（例如某条被取消后其余继续），
// 也保证「已排队但未激活」的消息不会因为另一次激活而丢状态。
export function queuePromptTelemetry(input: {
  workspacePath: string;
  taskId: string;
  messageId: string;
  inputId?: InputId;
  sendTime: number;
  extraDetail?: Record<string, string>;
}) {
  const { inputStartTime, inputFirstCharTime } = consumeComposerInputTiming(
    input.workspacePath,
    input.sendTime,
  );
  const promptTelemetry = createPromptTelemetryState({
    taskId: input.taskId,
    messageId: input.messageId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    sendTime: input.sendTime,
    inputStartTime,
    inputFirstCharTime,
    ...(input.extraDetail ? { extraDetail: input.extraDetail } : {}),
  });

  const existingQueue = queuedPromptTelemetryByTask.get(input.taskId) ?? [];
  queuedPromptTelemetryByTask.set(input.taskId, [...existingQueue, promptTelemetry]);

  // 返回值直接作为 send_btn 的字段集合：它必须来自刚创建的这份 prompt state，
  // 而不是调用方另行拼装，否则发送埋点与后续 completion 的模型维度会对不上（INV-14）。
  return {
    ...promptTelemetry.baseEventExtraDetail,
    input_start_time: String(inputStartTime),
    input_first_char_time: String(inputFirstCharTime),
    input_send_time: String(input.sendTime),
  };
}

// 激活条件是 messageId 精确匹配：queue 里可能有多条同 task 消息，按队首激活会在
// 重发/取消/重绑定场景下激活错误的 prompt，导致 completion 的 messageId 张冠李戴。
// 找不到就静默返回：说明该消息已被 discard 或从未纳入遥测，不能补建。
export function activatePromptTelemetry(taskId: string, messageId: string): void {
  const queue = queuedPromptTelemetryByTask.get(taskId);
  if (!queue || queue.length === 0) {
    return;
  }

  const targetIndex = queue.findIndex((item) => item.messageId === messageId);
  if (targetIndex === -1) {
    return;
  }

  const [target] = queue.splice(targetIndex, 1);
  if (!target) {
    return;
  }

  // [资源] 队列清空后删除 taskId 键：否则长会话里 taskId 只增不减，Map 无界增长。
  // 非空时写回 splice 后的同一数组引用：这里没有并发写入者（见文件头并发说明）。
  if (queue.length === 0) {
    queuedPromptTelemetryByTask.delete(taskId);
  } else {
    queuedPromptTelemetryByTask.set(taskId, queue);
  }

  activePromptTelemetryByTask.set(taskId, target);
  // 新建 step state 而不是复用：上一条消息的 loopIndex 与残留 step 必须丢弃（INV-9）。
  // 这里不调 delete 再 set：直接覆盖即可，省一次中间态。
  agentStepTelemetryByTask.set(taskId, createAgentStepTelemetryState());
}

/** background child 只复用 agent_step 状态，不创建或上报独立的 message 生命周期。 */
export function activateDetachedAgentStepTelemetry(input: {
  taskId: string;
  messageId: string;
  sendTime: number;
  extraDetail?: Record<string, string>;
}): void {
  // background 轮不产生 message_completion：它复用 agent_step 通道，因此这里只建 prompt 壳
  // （提供模型维度兜底）与 step state，不做 finalize、也不进入 queue。
  // 三个时间字段都取 sendTime：后台轮没有用户输入，输入耗时口径固定为 0，避免出现负值。
  activePromptTelemetryByTask.set(
    input.taskId,
    createPromptTelemetryState({
      taskId: input.taskId,
      messageId: input.messageId,
      sendTime: input.sendTime,
      inputStartTime: input.sendTime,
      inputFirstCharTime: input.sendTime,
      ...(input.extraDetail ? { extraDetail: input.extraDetail } : {}),
    }),
  );
  agentStepTelemetryByTask.set(input.taskId, createAgentStepTelemetryState());
}

// 只改「排队中」的 messageId，不碰已激活状态：重绑定发生在发送前（占位消息替换为真实 id）。
// 若激活后重绑定，历史事件已经带着旧 id 上报，改名只会制造两条对不上的记录。
// 原地替换数组元素而不是重建数组：保持其它排队项的相对顺序不变。
export function rekeyQueuedPromptTelemetry(
  taskId: string,
  fromMessageId: string,
  toMessageId: string,
): void {
  if (fromMessageId === toMessageId) {
    return;
  }

  const queue = queuedPromptTelemetryByTask.get(taskId);
  if (!queue || queue.length === 0) {
    return;
  }

  const targetIndex = queue.findIndex((item) => item.messageId === fromMessageId);
  if (targetIndex === -1) {
    return;
  }

  const target = queue[targetIndex];
  if (!target) {
    return;
  }

  queue[targetIndex] = {
    ...target,
    messageId: toMessageId,
  };
  queuedPromptTelemetryByTask.set(taskId, queue);
}

export function recordPromptModelRequestStarted(
  taskId: string,
  event: Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }>,
  activeInputId?: string,
): void {
  // 只处理 model_request_started：其余网络状态事件（重试、限流、连接建立）不改变模型维度。
  // 早退条件都是「无法确定这是不是当前 input 的请求」，宁可不覆盖，也不能写错维度。
  if (event.statusType !== "model_request_started") {
    return;
  }

  const active = activePromptTelemetryByTask.get(taskId);
  if (!active) {
    return;
  }

  const expectedInputId = activeInputId ?? active.inputId;
  // inputId 对齐是必需的：queued prompt 可能在发送时被重新绑定 inputId，
  // 只用 taskId 匹配会让上一个 input 的迟到请求覆盖当前消息的模型维度。
  // 两侧都有值才比较：老事件不带 inputId，强行比较会把合法事件全部过滤掉。
  if (expectedInputId && event.inputId && expectedInputId !== event.inputId) {
    return;
  }

  const modelProvider = event.providerId?.trim();
  const rawModelName = event.modelId?.trim();
  const providerHostname = resolveProviderHostname(event.baseURL);
  // 当 provider 与 model 都存在、且 model 自身不带 provider 前缀时补成 `provider/model`，
  // 与 UI model value 的格式对齐；若 model 已含 `/`，再拼一次会得到 `a/b/c`，
  // 数仓按 `/` 切分取 provider 时就会错位。
  const modelName =
    rawModelName && modelProvider && !readProviderIdFromModelValue(rawModelName)
      ? `${modelProvider}/${rawModelName}`
      : rawModelName;
  if (!modelProvider && !modelName) {
    return;
  }

  // currentModelRequest 是「下一次 createAgentStep 的模型快照源」，不是全局当前模型。
  // 它只在 request_started 时覆盖；step 创建时展开拷贝，之后不再信任共享字段（INV-3）。
  const state = getAgentStepTelemetryState(taskId);
  state.currentModelRequest = {
    ...(event.requestId?.trim() ? { requestId: event.requestId.trim() } : {}),
    modelName: modelName ?? active.baseEventExtraDetail.model_name ?? "",
    modelProvider: modelProvider ?? active.baseEventExtraDetail.model_provider ?? "",
    providerName: providerHostname || active.baseEventExtraDetail.provider_name || "",
  };
  // [权衡] 这里是 INV-14 的唯一例外：request_started 是「真实请求事实」，比发送时的 UI 快照更可信。
  // 因此只覆盖三个模型字段，绝不整体替换 —— 整体替换会丢掉 ask_mode、plan_status 等发送态维度，
  // 那些字段在 request_started 里根本不存在。
  active.baseEventExtraDetail = {
    ...active.baseEventExtraDetail,
    // 修复原因：send_btn 是 UI 选择快照，但 message_completion/agent_step 要尽量代表真实模型请求。
    // 自定义供应商切换时 workspace configOptions 可能仍是 builtin 模型；这里用运行时 request_started 回包覆盖完成态模型维度。
    ...(modelName ? { model_name: modelName } : {}),
    ...(modelProvider ? { model_provider: modelProvider } : {}),
    ...(providerHostname ? { provider_name: providerHostname } : {}),
  };
}

function findModelOutputStepForRequest(
  state: AgentStepTelemetryState,
  requestId: string,
): ActiveAgentStep | undefined {
  // 候选顺序固定为 generation → reasoning：两者可能同属一个 request（思考后转正文），
  // 但 token 应记在正文 step 上，因为它是该请求的最终产出。
  // 反序会让 reasoning step 吃掉正文的 usage，正文 step 的 token 恒为 0。
  const candidates = [state.generationStep, state.reasoningStep];
  return candidates.find((step) => step?.model?.requestId === requestId) ?? undefined;
}

function assignUsageToStep(step: ActiveAgentStep, attribution: AgentStepUsageAttribution): void {
  // requestIds 去重但 requestCount 累加：一次请求可能因重连被上报两次（不同 eventKey），
  // 明细去重避免同一 id 重复出现，count 累加保留真实请求次数 —— 两者语义不同，不能互相推导。
  // scope 一旦出现 subagent_requests 就永久保持：混合来源的 step 整体归到子代理口径，
  // 否则同一 step 的 token 会同时落进两个分母（见 AgentStepUsageAttribution 的说明）。
  step.usage = step.usage
    ? {
        requestIds: [...new Set([...step.usage.requestIds, ...attribution.requestIds])],
        requestCount: step.usage.requestCount + attribution.requestCount,
        scope:
          step.usage.scope === "subagent_requests" || attribution.scope === "subagent_requests"
            ? "subagent_requests"
            : "model_request",
        usage: mergePromptUsage(step.usage.usage, attribution.usage),
      }
    : attribution;
}

/**
 * 将 Subagent 的真实模型与累计 usage 写入其 Agent step。
 * foreground 使用父 task state，background 使用 detached child state。
 */
// 归因发生在工具 step 仍活动时：step 已关闭就丢弃，而不是新建一个 step 补报。
// 理由：工具墙钟已经结束，补报的 step 会排在后续 loop 之后，step 顺序与真实执行顺序不一致；
// 丢掉的只是这一个工具的 plugin/role 维度，不影响 token 与成功率口径。
export function recordSubagentToolAttribution(input: {
  taskId: string;
  toolCallId: string;
  requestIds: string[];
  requestCount: number;
  modelName: string;
  modelProvider: string;
  providerName: string;
  agentId: string;
  agentRole?: AgentStepRole;
  usage?: ZCodeUsage;
}): void {
  const state = agentStepTelemetryByTask.get(input.taskId);
  const step = state?.toolStepsById.get(input.toolCallId);
  if (!step) return;

  step.agentId = input.agentId;
  step.agentRole = input.agentRole ?? "foreground subagent";
  if (input.modelName || input.modelProvider || input.providerName) {
    step.model = {
      modelName: input.modelName,
      modelProvider: input.modelProvider,
      providerName: input.providerName,
    };
  }
  if (input.usage) {
    // Bug 根因：取消/失败时父 Agent 工具终态可能早于 SubagentStopped。若只在 stopped
    // 时首次归因，工具 step 已从活动索引删除，只能错误回退主模型且 token 为 0。
    // child fact 每次携带的是当前生命周期累计值，这里覆盖而不是叠加，避免增量同步重复计数。
    step.usage = {
      requestIds: [...input.requestIds],
      requestCount: input.requestCount,
      scope: "subagent_requests",
      usage: { ...input.usage },
    };
  }
}

// 工具事件的归因可能晚到（流式事件顺序不保证）：这里用「有则覆盖」而不是「首次写入后锁定」，
// 因为后到的归因来自更接近真实执行的事实（例如子代理解析出 role 之后）。
// agentRole 缺省为前台：与主链路语义一致，避免老调用方漏传时出现空 role 维度。
function applyAgentStepToolAttribution(
  step: ActiveAgentStep,
  attribution: AgentStepToolAttribution | undefined,
): void {
  if (!attribution) return;
  if (attribution.agentId) {
    step.agentId = attribution.agentId;
    step.agentRole = attribution.agentRole ?? "foreground subagent";
  }
  if (attribution.modelName || attribution.modelProvider || attribution.providerName) {
    step.model = {
      modelName: attribution.modelName ?? "",
      modelProvider: attribution.modelProvider ?? "",
      providerName: attribution.providerName ?? "",
    };
  }
}

// [失败路径] 只有 Skill 工具需要 skill 维度；其他工具即使带了同名 metadata 也丢弃，
// 否则会出现 tool_name=X 却带 skill_name 的组合，污染按工具聚合的看板。
// name 与 source 必须同时存在：只解析到其中之一说明是半成品归因，
// 用半成品上报会让「同名不同来源」的 skill 被合并。
function applyAgentStepSkillMetadata(
  step: ActiveAgentStep,
  metadata: AgentStepSkillMetadata | undefined,
): void {
  if (!metadata || step.toolName !== "Skill") return;
  // 只接收已解析 metadata；绝不能用 input.skill/name 补齐失败调用的名称。
  const name =
    metadata.source && metadata.name !== undefined
      ? sanitizeTelemetrySkillName(metadata.name)
      : undefined;
  step.skillMetadata = {
    ...step.skillMetadata,
    ...(name ? { name } : {}),
    ...(metadata.qualifiedName ? { qualifiedName: metadata.qualifiedName } : {}),
    ...(metadata.pluginId ? { pluginId: metadata.pluginId } : {}),
    ...(metadata.source ? { source: metadata.source } : {}),
  };
}

// [时序] 「模型直接返回 tool_use」的补洞：前置条件全部满足才补一个零时长 generation。
// 已有正文/思考 step 说明 usage 会自然归属，再补一个 step 会把同一次请求拆成两行；
// 没有对应 requestId 的 pending usage 说明这次请求没产生 token，补 step 只会制造空样本。
// 三者缺一不可，少判任何一个都会让 token 维度或 step 数量二选一地失真。
function materializePendingModelUsageBeforeTool(input: {
  prompt: PromptTelemetryState;
  state: AgentStepTelemetryState;
  now: number;
  finalized: FinalizedAgentStepTelemetry[];
  clientMode?: AgentStepTelemetryClientMode;
}): void {
  const requestId = input.state.currentModelRequest?.requestId;
  if (
    !requestId ||
    input.state.reasoningStep ||
    input.state.generationStep ||
    !input.state.pendingUsageByRequestId.has(requestId)
  ) {
    return;
  }

  // Bug 根因：模型直接返回 tool_use 时没有正文 step，旧逻辑会让 pending usage
  // 被随后创建的工具 step 消费。Agent 工具再叠加 child usage 后，就会把主模型 A
  // 和 child 模型 B 的 token 混在同一模型维度。这里补一个零时长 generation，
  // 只承接本次真实模型 request；工具 step 保持独立，等待工具或前台 child 的事实。
  input.state.generationStep = createAgentStep(input.state, "generation", input.now);
  closeGenerationStep(
    input.prompt,
    input.state,
    input.now,
    "success",
    input.finalized,
    undefined,
    "tool_call",
    input.clientMode,
  );
}

// agent_step 状态机入口：按事件类型推进 step，并返回本事件「收口」的 step 列表。
// 返回列表而不是内部回调上报，是为了让调用方决定上报时机与批处理；本函数自身不产生 IO，
// 因此可以在单测里用合成事件直接驱动。
// 未识别的事件类型返回空数组：协议会持续新增事件，遥测不能因为不认识就抛错（INV-10）。
export function recordAgentStepTelemetryEvent(input: {
  taskId: string;
  event: ZCodeStreamEvent;
  activeInputId?: string;
  clientMode?: AgentStepTelemetryClientMode;
  toolAttribution?: AgentStepToolAttribution;
  skillMetadata?: AgentStepSkillMetadata;
  now?: number;
}): FinalizedAgentStepTelemetry[] {
  const prompt = activePromptTelemetryByTask.get(input.taskId);
  // 没有 active prompt 说明这条消息未纳入遥测（例如 background child 走 detached 通道，
  // 或消息在激活前就已结束）。静默丢弃而不是补建 state：补建会得到缺 sendTime 的
  // 半成品，算出的 duration 与 TTFT 都是无意义的负值。
  if (!prompt) {
    return [];
  }
  const eventInputId =
    "inputId" in input.event && typeof input.event.inputId === "string"
      ? input.event.inputId
      : undefined;
  // 只有两侧都带 inputId 才比较：老事件没有该字段，强行比较会把合法事件全部过滤，
  // 表现为工具 step 整段缺失。ownership 以 runtime activeInputId 为准，
  // 是因为 queued prompt 在发送时会被重新绑定 inputId（见 rekeyQueuedPromptTelemetry）。
  if (input.activeInputId && eventInputId && input.activeInputId !== eventInputId) {
    // Bugfix：completion 改用逐 step 聚合后，旧 input 的迟到 chunk/tool 也会污染当前 message。
    // ownership 以 runtime activeInputId 为准，兼容 queued prompt 发送时实际 inputId 重绑定。
    return [];
  }

  const now = input.now ?? Date.now();
  const state = getAgentStepTelemetryState(input.taskId);
  const finalized: FinalizedAgentStepTelemetry[] = [];

  switch (input.event.type) {
    // 思考分片：首个分片即视为「已开始输出」，因此在这里记首 token。
    // 不要等到正文分片才记：思考阶段已经产生可观的首字延迟，漏记会让 TTFT 只覆盖后段。
    case "agent_thought_chunk":
      markPromptFirstToken(prompt, now);
      // reasoning 与 generation 互斥：开启思考前必须先关闭正文 step，
      // 否则下一段正文会复用旧 generation 的 startedAt，duration 跨越两段输出。
      // 只关闭一次（!state.reasoningStep 才进）：后续分片重复关闭会产生多条零时长 step。
      if (!state.reasoningStep) {
        closeGenerationStep(
          prompt,
          state,
          now,
          "success",
          finalized,
          undefined,
          "reasoning",
          input.clientMode,
        );
        state.reasoningStep = createAgentStep(state, "reasoning", now);
      }
      return finalized;

    // 正文分片：zcodeTimeline 是时间线投影，parentToolUseId 是子代理/工具输出，
    // 两者都不属于主 assistant 正文。计入正文会让 TTFT 提前、body step 的 token
    // 归属到错误层级，而且工具卡片输出会被重复算进正文长度。
    case "agent_message_chunk":
      if (input.event.zcodeTimeline) {
        return finalized;
      }
      if (input.event.parentToolUseId) {
        // 修复原因：带 parentToolUseId 的 chunk 是工具/子 agent 输出，UI 会挂到工具卡片；
        // 不能把它当主 assistant 正文创建 generation step 或刷新正文尾包时间。
        return finalized;
      }
      markPromptFirstToken(prompt, now);
      closeReasoningStep(prompt, state, now, finalized);
      if (!state.generationStep) {
        state.generationStep = createAgentStep(state, "generation", now);
      }
      state.generationStep.lastMessageChunkAt = now;
      // 每个正文分片都刷新 `lastMessageChunkAt`，直到 `finalize` 才定格供尾延迟与生成耗时共用。
      // 若只在创建时写一次，尾延迟会退化成整段正文时长，长回答被系统性高估。
      return finalized;

    // 工具调用到达即关闭正文与思考：模型不会再为这一轮继续输出正文。
    // 顺序不能反：必须先 close 再 createAgentStep，才能保证新 step 的 loopIndex 最大、
    // 且拿到的是最近的模型快照；反过来会让工具 step 继承上一轮的模型/序号。
    case "tool_call": {
      markPromptFirstToken(prompt, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "success",
        finalized,
        undefined,
        "tool_call",
        input.clientMode,
      );
      materializePendingModelUsageBeforeTool({
        prompt,
        state,
        now,
        finalized,
        clientMode: input.clientMode,
      });
      const toolStep = createAgentStep(state, "tool_call", now, {
        toolId: input.event.toolId,
        toolName: input.event.toolName ?? input.event.kind,
      });
      applyAgentStepToolAttribution(toolStep, input.toolAttribution);
      if (input.event.pluginMetadata) toolStep.pluginMetadata = input.event.pluginMetadata;
      applyAgentStepSkillMetadata(toolStep, input.skillMetadata ?? input.event.skillMetadata);
      applySettledPermissionWaitAttribution(state, toolStep);
      // 先归因再入索引：入索引后 step 可能被紧随的终态事件立即消费，
      // 晚归因会丢字段，表现为工具 step 的 plugin/skill/waiting_ms 时有时无。
      state.toolStepsById.set(input.event.toolId, toolStep);
      return finalized;
    }

    // pending / in_progress 但索引里没有 step：说明 tool_call 事件丢失或乱序，
    // 这里补建 step 以承接后续终态；已有 step 则直接返回，不重复创建。
    // 补建路径必须和 tool_call 走完全相同的归因顺序，否则同一个工具在不同链路上
    // 会得到不同的字段集合，数仓无法按列对账。
    case "tool_call_update": {
      markPromptFirstToken(prompt, now);
      if (input.event.status === "pending" || input.event.status === "in_progress") {
        if (!state.toolStepsById.has(input.event.toolId)) {
          closeReasoningStep(prompt, state, now, finalized);
          closeGenerationStep(
            prompt,
            state,
            now,
            "success",
            finalized,
            undefined,
            "tool_call",
            input.clientMode,
          );
          materializePendingModelUsageBeforeTool({
            prompt,
            state,
            now,
            finalized,
            clientMode: input.clientMode,
          });
          const toolStep = createAgentStep(state, "tool_call", now, {
            toolId: input.event.toolId,
            toolName: input.event.toolName ?? input.event.kind,
          });
          applyAgentStepToolAttribution(toolStep, input.toolAttribution);
          if (input.event.pluginMetadata) toolStep.pluginMetadata = input.event.pluginMetadata;
          applyAgentStepSkillMetadata(toolStep, input.skillMetadata ?? input.event.skillMetadata);
          applySettledPermissionWaitAttribution(state, toolStep);
          state.toolStepsById.set(input.event.toolId, toolStep);
        }
        return finalized;
      }

      // 终态分支：无论之前是否建过 step，都必须在本事件内收口并移出索引。
      // 否则这个工具会一直留在活动索引，直到 task 终态被批量关闭 —— 届时 status 已失准，
      // 且它的 waiting_ms 会重复计入。这里是工具 step 唯一的释放点。
      let existing = state.toolStepsById.get(input.event.toolId);
      if (!existing) {
        materializePendingModelUsageBeforeTool({
          prompt,
          state,
          now,
          finalized,
          clientMode: input.clientMode,
        });
        existing = createAgentStep(
          state,
          "tool_call",
          findEarliestPermissionRequestedAt(prompt, state, input.event.toolId) ?? now,
          {
            toolId: input.event.toolId,
            toolName: input.event.toolName ?? input.event.kind,
          },
        );
      }
      if (input.event.pluginMetadata) existing.pluginMetadata = input.event.pluginMetadata;
      applyAgentStepSkillMetadata(existing, input.skillMetadata ?? input.event.skillMetadata);
      applyAgentStepToolAttribution(existing, input.toolAttribution);
      // 修复原因：恢复/乱序链路可能先看到 permission_request，随后直接收到工具终态，
      // 没有前置 tool_call。先回填已收口等待，再把兜底 step 放回索引消费仍开放的等待，
      // 最后校正 startedAt，保证工具墙钟耗时始终覆盖 waiting_ms。
      applySettledPermissionWaitAttribution(state, existing);
      state.toolStepsById.set(input.event.toolId, existing);
      settlePermissionWaitsForTool(prompt, state, input.event.toolId, now);
      existing.startedAt = Math.min(existing.startedAt, now - existing.waitingMs);
      state.toolStepsById.delete(input.event.toolId);
      finalized.push(
        finalizeAgentStep({
          prompt,
          step: {
            ...existing,
            toolName: input.event.toolName ?? input.event.kind ?? existing.toolName,
          },
          finishedAt: now,
          status: input.event.status,
          // 只有 failed 才带 TOOL_EXEC_ERROR：denied / timeout 由 status 本身表达，
          // 统一塞同一个 error_type 会让数仓无法区分「用户拒绝」与「执行异常」，
          // 而这两类的产品动作完全不同（前者要优化权限提示，后者要修工具）。
          errorType: input.event.status === "failed" ? "TOOL_EXEC_ERROR" : undefined,
          errorMsg: input.event.error,
          // Bug 原因：兼容流过去只把工具名和状态交给 agent_step，CronCreate
          // 返回的新任务 ID 留在 content 中，导致运营无法关联创建步骤与任务。
          automationId:
            input.event.status === "completed" &&
            (input.event.toolName ?? input.event.kind ?? existing.toolName) === "CronCreate"
              ? cronCreateAutomationId(input.event.content)
              : undefined,
        }),
      );
      return finalized;
    }

    // 终态顺序固定：先结算等待（否则等待时长取决于后续关闭顺序），再关正文/思考，
    // 最后批量关工具。反过来先关工具会让工具的 waiting_ms 永远拿不到仍开放的 permission 等待，
    // 表现为「工具耗时 < 等待时间」。
    case "task_complete":
      settleAllPermissionWaits(prompt, state, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "success",
        finalized,
        undefined,
        "task_complete",
        input.clientMode,
      );
      closeToolSteps(prompt, state, now, "success", finalized);
      // [资源] 这是 task 级 step state 唯一的释放点：漏删会让 loopIndex 与残留 step
      // 跨消息泄漏，下一条消息从上一轮序号继续（INV-9）。
      agentStepTelemetryByTask.delete(input.taskId);
      return finalized;

    // 错误码缺失时用 UNKNOWN 而不是空串：空串会被数仓当成「无错误」而落到成功分桶，
    // UNKNOWN 才能进入失败分桶并被单独观察。
    case "task_error":
      settleAllPermissionWaits(prompt, state, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "fail",
        finalized,
        {
          type: input.event.code ?? "UNKNOWN",
          msg: input.event.error,
        },
        "task_error",
        input.clientMode,
      );
      closeToolSteps(prompt, state, now, "fail", finalized, {
        type: input.event.code ?? "UNKNOWN",
        msg: input.event.error,
      });
      // task_error 同样必须删除 state：错误态不会再有事件到达，留着只会污染下一条消息。
      agentStepTelemetryByTask.delete(input.taskId);
      return finalized;

    // 未知事件类型不是错误：协议先行、UI 后到是常态。
    // 返回空数组让调用方继续处理，绝不能 throw —— 那会把「有未知事件」升级成「对话失败」。
    default:
      return finalized;
  }
}

// 与 markPromptFirstToken 同语义，供拿不到内部 state 的调用方使用。
// 保留两个入口而不是合并：一个走流事件内部、一个走 UI 层，合并会把 UI 层依赖带进事件处理。
// 这里先判 firstTokenAt !== null 而不是直接赋值，保证幂等（INV-7）。
export function recordPromptFirstToken(taskId: string, now = Date.now()): void {
  const active = activePromptTelemetryByTask.get(taskId);
  if (!active || active.firstTokenAt !== null) {
    return;
  }

  active.firstTokenAt = now;
}

// 当前激活 prompt 的模型名,供 ARMS 镜像事件(stream_stall 等)补齐 model 维度;
// 无激活 prompt 或未带 model_name 时返回 undefined,由调用方留空。
export function getActivePromptModelName(taskId: string): string | undefined {
  const active = activePromptTelemetryByTask.get(taskId);
  return active?.baseEventExtraDetail.model_name || undefined;
}

export function getActivePromptMessageId(taskId: string): string | undefined {
  return activePromptTelemetryByTask.get(taskId)?.messageId;
}

export function recordPromptTokenUsageDelta(input: {
  taskId: string;
  eventKey: string;
  usage: ZCodeUsage;
  requestId?: string;
  modelName?: string;
  modelProvider?: string;
  providerName?: string;
}): void {
  // [并发] 去重检查与累加必须紧邻，中间不允许 await：当前实现是同步的，
  // 一旦引入异步（例如先查缓存再累加），同一 eventKey 的两次调用都能通过 has 检查，
  // token 被重复累加（INV-4）。eventKey 为空串时直接丢弃，否则所有空 key 会互相去重。
  const active = activePromptTelemetryByTask.get(input.taskId);
  const eventKey = input.eventKey.trim();
  if (!active || eventKey.length === 0 || active.usageEventKeys.has(eventKey)) {
    return;
  }

  active.usageEventKeys.add(eventKey);
  active.usage = mergePromptUsage(active.usage, input.usage);

  const requestId = input.requestId?.trim();
  if (!requestId) return;
  const state = getAgentStepTelemetryState(input.taskId);
  const modelName = input.modelName?.trim();
  const modelProvider = input.modelProvider?.trim();
  const providerName = input.providerName?.trim();
  const step = findModelOutputStepForRequest(state, requestId);
  if (step) {
    // 合并同一 step 的多次请求：正文可能分多段请求，累加后 step 才有完整的 token 口径。
    // 同时用本次请求的维度覆盖 step.model：晚到的 usage 往往带有更准确的 provider 信息。
    // 注意只覆盖非空值（?? 旧值），否则一次缺字段的 delta 会把已有模型名清空。
    step.model = {
      requestId,
      modelName: modelName ?? step.model?.modelName ?? "",
      modelProvider: modelProvider ?? step.model?.modelProvider ?? "",
      providerName: providerName ?? step.model?.providerName ?? "",
    };
    assignUsageToStep(step, {
      requestIds: [requestId],
      requestCount: 1,
      scope: "model_request",
      usage: input.usage,
    });
    return;
  }

  // 找不到对应 step 时暂存而不是丢弃：usage 事件可能先于 tool_call 到达（V4 顺序不保证），
  // 丢弃会让该 step 的 token 恒为 0（INV-5）。暂存后由 createAgentStep 或
  // materializePendingModelUsageBeforeTool 消费，二者都按 requestId 精确匹配。
  state.pendingUsageByRequestId.set(requestId, {
    requestIds: [requestId],
    requestCount: 1,
    scope: "model_request",
    usage: input.usage,
  });
}

// requestId 去重：同一 permission 会重复广播（重连/重放），重复记录会让等待时长
// 从最后一次广播开始算，被人为缩短。这里按 requestId 而不是 toolCallId 去重，
// 因为一个工具可能连续弹多次权限确认，每次都应有独立的等待区间。
export function recordPromptPermissionRequest(input: {
  taskId: string;
  requestId: string;
  toolCallId?: string;
  raw?: unknown;
  now?: number;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  const requestId = input.requestId.trim();
  if (!active || requestId.length === 0 || active.permissionWaitsByRequestId.has(requestId)) {
    return;
  }

  const raw =
    input.raw !== null && typeof input.raw === "object"
      ? (input.raw as Record<string, unknown>)
      : {};
  const rawToolCallId =
    typeof raw.toolCallId === "string" && raw.toolCallId.trim().length > 0
      ? raw.toolCallId.trim()
      : undefined;
  // toolCallId 三级兜底：入参 > raw.toolCallId > requestId。
  // 用 requestId 兜底保证 key 非空；它不对应真实工具，因此只会被结算进 prompt 总量，
  // 不会挂到某个工具维度上 —— 这比丢失整段等待更可接受。
  // raw 先做对象类型收窄：协议里 raw 可能是字符串或 null，直接取属性会抛错。
  const toolCallId = input.toolCallId?.trim() || rawToolCallId || requestId;
  active.permissionWaitsByRequestId.set(requestId, {
    requestedAt: input.now ?? Date.now(),
    ...(toolCallId ? { toolCallId } : {}),
  });
}

// 结算走统一函数：这里不判断请求是否存在，settlePermissionWait 内部对未知 requestId
// 直接返回，保证重复响应/迟到响应幂等（INV-6）。
// 第二个参数允许 undefined（task 级 step state 已释放），此时只结算消息级等待。
export function recordPromptPermissionResponse(input: {
  taskId: string;
  requestId: string;
  now?: number;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  if (!active) {
    return;
  }

  settlePermissionWait(
    active,
    agentStepTelemetryByTask.get(input.taskId),
    input.requestId,
    input.now ?? Date.now(),
  );
}

// 终态聚合：先结算所有开放等待并释放 task state，再读 state 拼字段。
// 顺序不能反 —— 结算会产生 waitingMs，若先拼后释放，这部分等待不会进入本次上报；
// 释放后再读则是纯快照，后续迟到事件也改不到它（INV-9 的前置动作）。
// 返回 null 而不是抛错：没有 active prompt 说明这条消息不归本模块管（INV-10）。
export function finalizePromptTelemetry(
  input: FinalizePromptTelemetryInput,
): FinalizedPromptTelemetry | null {
  const active = activePromptTelemetryByTask.get(input.taskId);
  if (!active) {
    return null;
  }

  settleAllPermissionWaits(active, agentStepTelemetryByTask.get(input.taskId), input.finishedAt);
  activePromptTelemetryByTask.delete(input.taskId);
  agentStepTelemetryByTask.delete(input.taskId);

  const { changedFileCount, generatedCodeLines } = collectFileChangeMetrics(input.fileChanges);
  const isSuccess = input.status === "success";
  // 失败态不采用 terminal usage：失败请求的 usage 可能只覆盖部分 token，
  // 用它会让失败消息的成本被低估；delta 累计值更接近真实消耗。
  // 因此才有 tokenSource=usage_delta 这一标记，数仓据此区分两种来源。
  // V4 live fact 的 usage 以低频 delta 到达，terminal 不重复携带整包累计值；
  // 旧链路仍可在 terminal 直接传 usage。成功态优先显式 terminal usage，缺省回落已聚合 delta。
  const usageForTelemetry = isSuccess
    ? (input.usage ?? active.usage ?? undefined)
    : (active.usage ?? undefined);
  const tokenSource = !isSuccess && active.usage ? "usage_delta" : undefined;
  const errorType = isSuccess
    ? ""
    // error_type 优先级：显式传入 > 工具失败汇总 > UNKNOWN。
    // 工具失败汇总保证「以工具异常结束」的消息不落进 UNKNOWN 桶，
    // 否则这类最常见的失败会被错误分类吞掉，无法定位。
    : input.errorType?.trim() || (active.toolCallFailed > 0 ? "TOOL_CALL_FAILED" : "UNKNOWN");
  const errorMsg = isSuccess ? "" : input.errorMsg?.trim() || active.firstToolCallError;

  return {
    taskId: input.taskId,
    messageId: active.messageId,
    eventExtraDetail: {
      ...legacyTelemetryModelFields(active.baseEventExtraDetail),
      ...(usageForTelemetry
        ? buildPromptUsageTelemetryExtraDetail(usageForTelemetry, tokenSource)
        : {}),
      duration_ms: String(Math.max(input.finishedAt - active.sendTime, 0)),
      // waiting_ms 已经是累加值，不再与 duration 求交：权限等待本身属于墙钟耗时的一部分，
      // 数仓用 duration_ms - waiting_ms 得到「纯执行时间」，做减法比这里预先扣减更灵活。
      waiting_ms: String(active.waitingMs),
      generated_code_lines: String(generatedCodeLines),
      file_change_cnt: String(changedFileCount),
      // TTFT 用 "-1" 表示未发生：数仓以 -1 作为可过滤的哨兵；
      // 用 0 会被当成「首 token 与发送同时发生」，拉低均值且无法与真实 0 区分。
      time_to_first_token:
        active.firstTokenAt === null
          ? "-1"
          : String(Math.max(active.firstTokenAt - active.sendTime, 0)),
      request_time: String(active.sendTime),
      status: input.status,
      ...(input.messageSource ? { message_source: input.messageSource } : {}),
      // agent_composition 缺省 main_only：老调用方不传时，语义等价于「只有主代理」。
      // 不能缺省为空串：空串在数仓里是一个独立维度值，会与未采集数据混在一起。
      agent_composition: input.agentComposition ?? "main_only",
      agent_step_cnt: String(active.finalizedAgentStepCount),
      // retry_cnt 固定 "0"：当前 runtime 的重试发生在模型客户端内部，没有独立计数源；
      // 保留该列是为了数仓 schema 稳定，删除列会让历史分区与新旧数据无法 union。
      retry_cnt: "0",
      tool_call_total: String(active.toolCallTotal),
      tool_call_failed: String(active.toolCallFailed),
      error_type: errorType,
      error_msg: errorMsg,
    },
  };
}

// 测试专用：清空全部进程级状态，保证用例之间不串味。
// 生产代码不得调用 —— 它会让所有进行中的消息丢失遥测，且不产生任何终态事件。
export function resetMessageTelemetryForTest(): void {
  composerInputTimingByWorkspace.clear();
  queuedPromptTelemetryByTask.clear();
  activePromptTelemetryByTask.clear();
  agentStepTelemetryByTask.clear();
}

/** workspace telemetry attachment 释放时只清自己的内部 task key，不影响其它 workspace。 */
export function discardPromptTelemetry(taskId: string): void {
  // [资源] 三个 Map 全删：attachment 释放后不应再产生任何该 task 的事件，
  // 留着 active 会让迟到事件继续写进已释放 workspace 的遥测，并占用内存直到进程退出。
  // 不能只删 active：queued 残留会在下一次激活时「复活」这条消息。
  queuedPromptTelemetryByTask.delete(taskId);
  activePromptTelemetryByTask.delete(taskId);
  agentStepTelemetryByTask.delete(taskId);
}

/** 仅丢弃尚未激活的单条 prompt，避免同 session 其它排队消息被一并清空。 */
export function discardQueuedPromptTelemetry(taskId: string, messageId: string): void {
  const queue = queuedPromptTelemetryByTask.get(taskId);
  if (!queue) return;
  const next = queue.filter((item) => item.messageId !== messageId);
  if (next.length === 0) {
    queuedPromptTelemetryByTask.delete(taskId);
    return;
  }
  queuedPromptTelemetryByTask.set(taskId, next);
}
