// 本地 microcompact：在完整 LLM compact 之前，用纯本地规则清空较早、可丢弃的工具结果正文。
// 输入为只读消息数组和策略配置；输出新消息数组、决策原因以及可选边界 payload，不写存储、不发请求、不打日志。
// 触发条件为“空闲超时”或“token 压力”；候选只限于可压缩工具、非错误（可配置）、非已清空、非媒体结果。
// 清理按 assistant 工具调用边界保留最近 N 组，低于最小节省量时整体回滚，保证不会做无效改写。
// 不变量：只改 message.content，不动消息顺序、toolCallId、toolName 与 toolCalls；媒体/错误结果默认保留。
import {
  MicrocompactStrategy,
  MicrocompactTrigger,
  modelMessageContentToText,
  type MicrocompactBoundaryPayload,
  type ModelMessageContent,
  type ToolCallId,
} from "@zcode/contracts";
import type { CompactModelMessage } from "./manual.js";
import { estimateMessageTokens } from "./manual.js";

// 被清理的工具结果统一替换为固定短文本；PREFIX 供外部日志/展示识别，MESSAGE 是实际写入 content 的值。
// 两者当前内容相同，但语义分开：改展示前缀不应影响幂等判断使用的 MESSAGE。
export const MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX = "[Old tool result content cleared]";
// 幂等哨兵：content 恰好等于该文本时视为已清理，后续 microcompact 不会重复计为候选。
export const MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE = "[Old tool result content cleared]";
// 每个 assistant 工具调用组默认保留的最近结果组数；值为正数时才保留，0 会在运行时被夹到至少 1。
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5;
// 距上次 assistant 完成超过该分钟数即按 TimeBased 触发，覆盖长时间空闲后恢复的场景。
export const DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES = 60;
// 实际节省 token 低于该值时不提交改写，避免为微小收益支付一次上下文改写成本。
export const DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS = 256;
// token 压力阈值为 auto compact 阈值的比例，默认 0.9，使 microcompact 先于完整 compact 发生。
export const DEFAULT_MICROCOMPACT_THRESHOLD_RATIO = 0.9;
// 从 auto compact 阈值中再让出的 token 缓冲，防止清理后立刻逼近完整压缩阈值。
export const DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS = 2_000;
// 默认可清理的工具白名单：这些工具结果通常可由重新执行恢复，清空正文相对安全。
// 未列出的工具（如 MCP 写入类）默认不清理，避免销毁不可重放的外部操作结果。
export const DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS = [
  "Read",
  "Bash",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Edit",
  "Write",
  "ApplyPatch",
] as const;

// 本地 microcompact 策略覆盖项；未提供的字段在运行时回落到模块默认常量，不会写回配置。
// enabled=false 时直接短路；thresholdTokens 未设置则不会因 TokenPressure 触发，只可能因空闲触发。
// 所有 token 字段单位为 token；idleThresholdMinutes 单位为分钟；计数字段为组数或消息条数。
export interface LocalMicrocompactPolicyConfig {
  // 总开关；仅显式 false 关闭，undefined 视为启用并走默认判定。
  enabled?: boolean;
  // token 压力阈值；未设置或非法时不做 token 触发，空闲触发仍可生效。
  thresholdTokens?: number;
  // 空闲触发分钟数；未设置时用默认 60 分钟，非法值同样回落默认。
  idleThresholdMinutes?: number;
  // 保留的最近工具结果组数；未设置默认 5，实际执行时至少保留 1 组。
  keepRecentToolResults?: number;
  // 可清理工具名白名单；未设置用 DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS，空数组表示没有任何候选。
  compactableToolNames?: readonly string[];
  // 是否连错误结果一起清理；仅 true 时纳入，默认保留错误内容供模型排障。
  clearErrorResults?: boolean;
  // 最小节省 token 数；未设置默认 256，低于该值回滚本次改写。
  minTokenSavings?: number;
}

// microcompact 处理的消息视图：在 CompactModelMessage 上补充工具结果元数据，用于识别可清理候选。
// toolName/toolCallId 由消息投影方提供；缺失时该消息不会成为候选。isError 仅显式 true 才视为错误。
// 本类型只描述输入，不决定清理结果；清理后仅 content 变化，其余字段保持原值。
export interface LocalMicrocompactMessage extends CompactModelMessage {
  // 工具结果是否为错误；undefined/false 按成功处理，错误结果默认不清。
  isError?: boolean;
  // assistant 的工具调用列表；这里要求 id 参与分组与边界 payload，未定义表示无调用。
  toolCalls?: Array<{ id: string; input: unknown; name: string }>;
  // 对应 assistant toolCall 的 id；缺失时无法与调用配对，直接跳过候选收集。
  toolCallId?: string;
  // 产生该结果的工具名；缺失时可由 resolveToolResultName 回调补全，否则跳过。
  toolName?: string;
}

// 本地 microcompact 边界 payload：借用契约中的 MicrocompactBoundaryPayload，但由本地流程负责 trace/turn，
// 因此先去掉 traceId/turnId，调用方再在持久化时补齐。字段单位均为 token 或消息条数。
export type LocalMicrocompactBoundaryPayload = Omit<
  MicrocompactBoundaryPayload,
  "traceId" | "turnId"
>;

// 一次 microcompact 判定的结果说明，reason 是稳定的状态机输出，调用方据此决定是否重试或记录。
// estimatedTokenCount 为改写前估算值；thresholdTokens 在未配置时为 undefined；trigger 仅在已触发时存在。
export interface LocalMicrocompactDecision {
  // 改写前消息数组的本地估算 token 总数，始终存在。
  estimatedTokenCount: number;
  // 结束原因：disabled 未启用；not_triggered 未达触发条件；no_candidates 无可清理项；
  // nothing_to_clear 候选不足以保留规则；below_min_savings 节省过小已回滚；applied 已提交。
  reason:
    | "disabled"
    | "not_triggered"
    | "no_candidates"
    | "nothing_to_clear"
    | "below_min_savings"
    | "applied";
  // 生效的 token 压力阈值；配置未提供或非法时为 undefined，不代表阈值为 0。
  thresholdTokens?: number;
  // 触发来源；未触发或 disabled 时缺失。
  trigger?: MicrocompactTrigger;
}

// 本地 microcompact 的返回信封：messages 始终是调用方可安全使用的新数组，即使未改动也做了克隆。
// payload 仅在 reason=applied 时提供，记录清理与保留的 toolCallId 以及节省量。
export interface LocalMicrocompactResult<T extends LocalMicrocompactMessage> {
  // 判定结果，reason 决定下游是否认为发生了改写。
  decision: LocalMicrocompactDecision;
  // 处理后消息数组；未应用时等同于输入克隆，不能通过引用判断是否修改。
  messages: T[];
  // 已应用的边界数据；未应用时为 undefined，不携带空 payload。
  payload?: LocalMicrocompactBoundaryPayload;
}

// 候选工具结果的内部定位信息：index 指向本次克隆后的消息数组下标，toolCallId 用于边界 payload 追溯。
// index 只在单次 maybeLocalMicrocompactMessages 调用内有效，不能跨调用缓存。
interface ToolResultCandidate {
  // messages 数组下标；写入时先判空再替换，避免并发/异常输入导致越界。
  index: number;
  // 对应工具调用 id；已在收集阶段校验非空，转换为 ToolCallId 时不再重复判空。
  toolCallId: string;
}

// 根据 auto compact 阈值推导默认 microcompact 触发阈值：取“比例阈值”和“阈值减缓冲”中的较小者。
// 结果夹在 [0, autoCompactThreshold] 内；阈值为 0/负数时返回 0，表示任何 token 量都可能触发。
// 纯计算，无副作用；调用方仍可显式 thresholdTokens 覆盖。
export function buildDefaultMicrocompactThreshold(autoCompactThreshold: number): number {
  const ratioThreshold = Math.floor(autoCompactThreshold * DEFAULT_MICROCOMPACT_THRESHOLD_RATIO);
  const bufferThreshold = autoCompactThreshold - DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS;
  return Math.max(0, Math.min(ratioThreshold, bufferThreshold));
}

// 执行一次本地 microcompact 判定：克隆输入、估算 token、判断是否触发、收集候选、清理旧组并决定是否回滚。
// 返回的 messages 永远是克隆后的新数组；未应用时内容与输入一致，但嵌套 content 块也做了浅层隔离。
// 副作用仅限内存改写，不写会话存储、不发事件；payload 只在 applied 时返回，调用方负责持久化与 trace 补齐。
// 所有早退都会携带稳定的 reason，且不会部分修改输入数组。
export function maybeLocalMicrocompactMessages<T extends LocalMicrocompactMessage>(input: {
  // 策略覆盖；未提供时全部使用默认值，不会读取外部配置。
  config?: LocalMicrocompactPolicyConfig;
  // 上次 assistant 完成时间戳（毫秒）；缺失则不启用空闲触发，非法数值同样忽略。
  lastAssistantCompletedAtMs?: number;
  // 只读消息数组；内部会整体克隆，调用方可继续持有原数组。
  messages: readonly T[];
  // 工具名解析回调；用于消息没有 toolName 时从外部映射补全，返回 undefined 表示放弃该候选。
  resolveToolResultName?: (message: T, index: number) => string | undefined;
  // 当前时间戳（毫秒）；仅用于空闲计算，缺失时取 Date.now()，便于测试注入。
  nowMs?: number;
}): LocalMicrocompactResult<T> {
  const config = input.config ?? {};
  // 先克隆再估算/改写：保证任何早退路径都不会把内部替换泄漏到调用方数组。
  const messages = input.messages.map(cloneLocalMicrocompactMessage);
  const estimatedTokenCount = estimateMessageTokens(messages);
  const thresholdTokens = positiveInt(config.thresholdTokens);

  // 显式关闭优先于任何触发条件，返回原始内容克隆，不产生 payload。
  if (config.enabled === false) {
    return {
      decision: { estimatedTokenCount, reason: "disabled", thresholdTokens },
      messages,
    };
  }

  const trigger = resolveMicrocompactTrigger({
    config,
    estimatedTokenCount,
    lastAssistantCompletedAtMs: input.lastAssistantCompletedAtMs,
    nowMs: input.nowMs,
    thresholdTokens,
  });
  // 未达到空闲或 token 条件时不做候选扫描，避免无意义的 O(n) 遍历。
  if (!trigger) {
    return {
      decision: { estimatedTokenCount, reason: "not_triggered", thresholdTokens },
      messages,
    };
  }

  const candidateGroups = collectCompactableToolResultGroups(
    messages,
    config,
    input.resolveToolResultName,
  );
  // 没有任何可清理工具结果时提前返回，不进入保留组计算。
  if (candidateGroups.length === 0) {
    return {
      decision: { estimatedTokenCount, reason: "no_candidates", thresholdTokens, trigger },
      messages,
    };
  }

  const keepCount =
    positiveInt(config.keepRecentToolResults) ?? DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS;
  // 至少保留一组，避免把最近一次工具结果也清空导致模型丢失当前操作依据。
  const boundedKeepCount = Math.max(1, keepCount);
  const clearGroupCount = Math.max(0, candidateGroups.length - boundedKeepCount);
  // 候选组数不超过保留组数时没有可清理项，提前返回。
  if (clearGroupCount === 0) {
    return {
      decision: { estimatedTokenCount, reason: "nothing_to_clear", thresholdTokens, trigger },
      messages,
    };
  }

  const toClear = candidateGroups.slice(0, clearGroupCount).flat();
  const toKeep = candidateGroups.slice(clearGroupCount).flat();
  for (const candidate of toClear) {
    const message = messages[candidate.index];
    // 防御式判空：候选下标来自同一数组，正常不会缺失；缺失则跳过该条而不是中断整次清理。
    if (!message) continue;
    messages[candidate.index] = {
      ...message,
      content: buildClearedToolResultContent(),
    };
  }

  const postTokenCount = estimateMessageTokens(messages);
  const tokensSaved = Math.max(0, estimatedTokenCount - postTokenCount);
  const minSavings = positiveInt(config.minTokenSavings) ?? DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS;
  // 节省量不足时回滚为输入克隆，避免提交几乎无收益的改写并产生无意义的边界记录。
  if (tokensSaved < minSavings) {
    return {
      decision: { estimatedTokenCount, reason: "below_min_savings", thresholdTokens, trigger },
      messages: input.messages.map(cloneLocalMicrocompactMessage),
    };
  }

  return {
    decision: { estimatedTokenCount, reason: "applied", thresholdTokens, trigger },
    messages,
    payload: {
      clearedMessageCount: toClear.length,
      clearedToolCallIds: toClear.map((candidate) => candidate.toolCallId as ToolCallId),
      keptToolCallIds: toKeep.map((candidate) => candidate.toolCallId as ToolCallId),
      postMicrocompactTokenCount: postTokenCount,
      preMicrocompactTokenCount: estimatedTokenCount,
      strategy: MicrocompactStrategy.LocalToolResultClear,
      tokensSaved,
      trigger,
    },
  };
}

// 判定本次是否触发 microcompact；返回 undefined 表示未触发。优先级：先空闲超时，再 token 压力。
// 空闲判断要求 lastAssistantCompletedAtMs 为有限数值，否则视为无空闲信号；nowMs 缺失时取当前时间。
// 不读取外部时钟或配置中心，所有输入显式传入，便于测试稳定复现。
function resolveMicrocompactTrigger(input: {
  // 策略配置，用于 idleThresholdMinutes。
  config: LocalMicrocompactPolicyConfig;
  // 当前估算 token 数，用于 token 压力比较。
  estimatedTokenCount: number;
  // 上次 assistant 完成时间戳（毫秒）；缺失或非法时跳过空闲触发。
  lastAssistantCompletedAtMs?: number;
  // 当前时间戳（毫秒）；缺失时用 Date.now()。
  nowMs?: number;
  // 已归一化的 token 阈值；缺失时跳过 token 触发。
  thresholdTokens?: number;
}): MicrocompactTrigger | undefined {
  const idleThresholdMinutes =
    positiveInt(input.config.idleThresholdMinutes) ?? DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES;
  if (
    input.lastAssistantCompletedAtMs !== undefined &&
    Number.isFinite(input.lastAssistantCompletedAtMs)
  ) {
    const elapsedMs = (input.nowMs ?? Date.now()) - input.lastAssistantCompletedAtMs;
    // 严格大于阈值才触发，恰好等于阈值仍视为未超时，避免边界抖动导致状态反复。
    if (elapsedMs > idleThresholdMinutes * 60_000) {
      return MicrocompactTrigger.TimeBased;
    }
  }

  // token 压力采用 >=，达到阈值即触发；与空闲触发互斥，先命中者优先。
  if (input.thresholdTokens !== undefined && input.estimatedTokenCount >= input.thresholdTokens) {
    return MicrocompactTrigger.TokenPressure;
  }

  return undefined;
}

// 收集可清理的工具结果，并按“assistant 工具调用轮次”分组；每组代表一次工具批次，保留策略以组为单位。
// 只读扫描：候选仅记录下标与 toolCallId，不读取/改写 content；toolName 可由回调补全。
// 过滤规则：必须有 toolCallId 与 toolName、工具在白名单、非错误（除非 clearErrorResults）、未清理、无媒体块。
// 空输入返回空数组；没有 assistant 分组时，第一条候选中途也会单独成组，避免漏掉尾部结果。
function collectCompactableToolResultGroups<T extends LocalMicrocompactMessage>(
  // 已克隆的消息数组，下标与后续写回一致。
  messages: readonly T[],
  // 策略配置，决定白名单、错误结果与回调之外的默认行为。
  config: LocalMicrocompactPolicyConfig,
  // 工具名解析回调；优先于 message.toolName，用于处理投影未带工具名的消息。
  resolveToolResultName?: (message: T, index: number) => string | undefined,
): ToolResultCandidate[][] {
  const compactableTools = new Set(
    config.compactableToolNames ?? DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS,
  );
  const clearErrorResults = config.clearErrorResults === true;
  const groups: ToolResultCandidate[][] = [];
  let currentGroup: ToolResultCandidate[] | undefined;

  const flushCurrentGroup = (): void => {
    // 空组不入列，避免产生“有组但无候选”的假阳性导致保留计数偏移。
    if (currentGroup && currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    currentGroup = undefined;
  };

  messages.forEach((message, index) => {
    // 新的 assistant 工具调用批次意味着上一批工具结果已结束，先封口再开启新组。
    // 普通 assistant 文本（无 toolCalls）不切组，使同一轮内的工具结果仍归入当前批次。
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      flushCurrentGroup();
      currentGroup = [];
      return;
    }

    if (message.role !== "tool") return;
    const toolName = resolveToolResultName
      ? resolveToolResultName(message, index)
      : message.toolName;
    // 缺 id 无法与 toolCall 配对、缺工具名无法判断是否安全，两种情况都直接跳过。
    if (!message.toolCallId || !toolName) return;
    if (!compactableTools.has(toolName)) return;
    // 错误结果是排障证据，默认保留；只有显式开启 clearErrorResults 才进入候选。
    if (message.isError && !clearErrorResults) return;
    // 已清理内容再次进入候选会虚增组数但不产生节省量，提前排除以保持幂等。
    if (isMicrocompactClearedToolResultContent(message.content)) return;
    // 媒体块清空后无法重建，必须保留原始引用。
    if (hasMediaToolResultContent(message.content)) return;

    // 没有 active 组时（例如工具结果前没有 assistant toolCalls），该结果单独成组，避免被静默忽略。
    if (!currentGroup) {
      groups.push([{ index, toolCallId: message.toolCallId }]);
      return;
    }

    currentGroup.push({ index, toolCallId: message.toolCallId });
  });

  flushCurrentGroup();
  return groups;
}

function buildClearedToolResultContent(): ModelMessageContent {
  return MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE;
}

function isMicrocompactClearedToolResultContent(content: ModelMessageContent): boolean {
  return modelMessageContentToText(content) === MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE;
}

function hasMediaToolResultContent(content: ModelMessageContent): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object" || !("type" in block)) return false;
    // video 与 image/file 同为受保护媒体：Read 视频结果漏判会被 microcompact 清掉。
    return block.type === "image" || block.type === "video" || block.type === "file";
  });
}

function cloneLocalMicrocompactMessage<T extends LocalMicrocompactMessage>(message: T): T {
  return {
    ...message,
    content: cloneContent(message.content),
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
  };
}

function cloneContent(content: ModelMessageContent): ModelMessageContent {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if ("source" in block && block.source) {
      return { ...block, source: { ...block.source } };
    }
    if ("providerOptions" in block && block.providerOptions) {
      return { ...block, providerOptions: { ...block.providerOptions } };
    }
    return { ...block };
  }) as ModelMessageContent;
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
