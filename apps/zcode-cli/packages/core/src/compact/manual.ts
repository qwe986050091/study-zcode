// 手动/显式 compact 的纯函数集合：负责消息裁剪、轮次判定、token 估算与边界记录构造。
// 输入均为只读消息数组或显式参数，不访问会话存储、不发起模型请求；返回新数组/新对象，持久化由调用方决定。
// token 数为本地估算值（字符数除以 ESTIMATED_TOKEN_CHAR_DIVISOR），仅 provider usage 才代表真实计费口径。
// 空数组、undefined 与缺失字段均有明确降级：过滤后为空、统计为 0、可选字段不写入边界。
// 不变量：摘要只覆盖过滤后的对话消息，system 前缀与 <system-reminder> 用户消息不进入摘要。
import { CompactTrigger } from "@zcode/contracts";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";
import type {
  CompactBoundaryPayload,
  CompactPhase,
  CompactPreservedSegment,
  CompactReason,
  CompactTrigger as CompactTriggerValue,
  MessageId,
  ModelMessageContent,
  TraceContext,
} from "@zcode/contracts";
import { modelMessageContentBlockToText, modelMessageContentToText } from "@zcode/contracts";
import { groupByAssistantStartedRounds } from "./rounds.js";

const EMPTY_TOOL_CALL_INPUT_JSON = "{}";

// compact 估算与摘要使用的消息视图：只保留判断轮次和计算体积所需字段，避免依赖完整会话消息类型。
// content 与 toolCalls 在摘要/透传时原样保留引用；本文件不会修改它们，只做浅拷贝。
// 输入来自会话消息投影，缺失 toolCalls 表示该消息没有工具调用，不等同于空调用列表。
export interface CompactModelMessage {
  // 消息角色，沿用上游字符串（system/user/assistant/tool），用于过滤上下文前缀与划分轮次。
  role: string;
  // 消息正文，字符串或内容块数组；紧凑估算会分别处理 reasoning 块与普通可见块。
  content: ModelMessageContent;
  // assistant 消息附带的工具调用；未定义表示没有调用，数组内 input 仍是未经校验的原始参数对象。
  toolCalls?: readonly {
    // 工具名，参与 token 估算字符数计算；空名仍按 0 长度处理。
    name: string;
    // 工具入参原始值，序列化失败时只能按空对象降级估算，不影响消息本身。
    input: unknown;
  }[];
}

// provider usage 的最小投影：兼容不同供应商字段名，只在 getUsageTotalTokens 中做缺省折算。
// 所有字段单位均为 token；undefined 表示供应商未上报，不等同于 0，但合计时会按缺省公式当 0 参与。
// reasoningTokens 仅用于观测，不额外累加，避免与 totalTokens/outputTokens 重复计数。
export interface TokenUsageLike {
  // 输入 token；未上报时由 cacheReadTokens + cacheWriteTokens 兜底，仍无则为 0。
  inputTokens?: number;
  // 输出 token；totalTokens 缺失时计入总量，未上报按 0 处理。
  outputTokens?: number;
  // 供应商直接给出的总量；存在时优先使用（即使是 0），不再按输入/输出重新相加。
  totalTokens?: number;
  // 推理 token，通常已包含在 outputTokens/totalTokens 内，这里只透传观测、不参与求和。
  reasoningTokens?: number;
  // 缓存命中读取 token；仅在 inputTokens 缺失时作为输入侧兜底。
  cacheReadTokens?: number;
  // 缓存写入 token；仅在 inputTokens 缺失时作为输入侧兜底。
  cacheWriteTokens?: number;
}

// 构造 compact 边界记录所需的显式输入；除标明可选的字段外都必须由 compact 流程提供。
// boundaryId、preCompactTokenCount、summarizedMessageCount、summaryMessageId、traceContext 是持久化与追溯的最小集合。
// 可选字段缺失时由 buildManualCompactBoundary 填默认值或直接省略，不会从会话中反查。
// 所有 token 字段单位均为 token；计数类字段为消息条数，不是 token 数。
export interface BuildManualCompactBoundaryInput {
  // compact 前已发现的工具名清单；为空数组时按 falsy 处理，不会写入边界。
  preCompactDiscoveredTools?: string[];
  // 本次决策使用的自动压缩阈值；仅用于审计，不影响边界生成。
  autoCompactThreshold?: number;
  // 本次 compact 的唯一标识，调用方生成，要求非空且在同一次压缩内稳定。
  boundaryId: string;
  // 触发压缩的原因分类；缺失时边界中不写入，不默认猜测。
  compactReason?: CompactReason;
  // 用户自定义压缩指令原文；边界只记录“是否提供”，不保存原文内容。
  customInstructions?: string;
  // 摘要后保留的原始消息条数；缺失时按 0 记录，表示未显式保留。
  keptMessageCount?: number;
  // 被摘要覆盖的最后一条消息 id；缺失表示没有可引用的消息锚点。
  lastSummarizedMessageId?: MessageId;
  // 压缩阶段标记；缺失时边界中不写入 phase 字段。
  phase?: CompactPhase;
  // 摘要完成后的估算 token 数；缺失表示服务端尚未回填。
  postCompactTokenCount?: number;
  // 摘要后保留的连续消息段；用于恢复时重建保留区，缺失表示没有保留段。
  preservedSegment?: CompactPreservedSegment;
  // 压缩前估算 token 数，必填，用于计算节省量。
  preCompactTokenCount: number;
  // 被纳入摘要的消息条数，必填，用于审计摘要覆盖面。
  summarizedMessageCount: number;
  // 生成的摘要消息 id，必填，边界会将其包装成单元素 summaryMessageIds。
  summaryMessageId: MessageId;
  // 关联的 trace/turn 上下文，必填，用于把 compact 事件挂回原会话调用链。
  traceContext: TraceContext;
  // 触发来源；缺失时默认 CompactTrigger.Manual。
  trigger?: CompactTriggerValue;
  // 压缩后真实 token 数（来自 provider usage）；缺失表示只能用估算值。
  truePostCompactTokenCount?: number;
  // 预估下一轮是否仍会再次触发压缩；缺失时边界不写入该判断。
  willRetriggerNextTurn?: boolean;
}

// compact prompt 因上下文过长被 provider 拒绝时，最多允许的重试次数。
// 每次重试会裁剪更早的消息并插入 RETRY_MARKER；达到上限后不再循环，直接走用户可见失败提示。
export const MAX_COMPACT_PROMPT_TOO_LONG_RETRIES = 3;
// 重试裁剪时插入对话的标记文本，用于向模型说明前文已被截断；同时可供后续识别本次重试。
export const COMPACT_PROMPT_TOO_LONG_RETRY_MARKER =
  "[earlier conversation truncated for compaction retry]";
// 自动 compact 重试耗尽后展示给用户的文案：提示其收窄上下文后手动重试，避免静默失败。
export const COMPACT_PROMPT_TOO_LONG_USER_MESSAGE =
  "Conversation too long to compact automatically. Try /compact again after narrowing the active context.";

// 从完整消息数组中挑出可进入摘要的对话消息，并做一层浅拷贝以隔离调用方可变对象。
// 过滤掉 system 消息与以 <system-reminder> 开头的 user 消息：它们是上下文前缀，不属于用户真实对话。
// 空数组返回空数组；不修改入参，也不深拷贝 content/toolCalls，调用方仍共享嵌套引用。
// 输出条数可能小于输入条数，摘要覆盖计数应使用本函数结果而不是原始数组长度。
export function getMessagesToSummarize(
  messages: readonly CompactModelMessage[],
): CompactModelMessage[] {
  return messages
    // 前缀消息由运行时注入，重复摘要会污染摘要内容，因此统一排除。
    .filter((message) => !isContextPrefixMessage(message))
    .map((message) => ({ ...message }));
}

// 判断消息是否足以做一次有意义的压缩：过滤前缀后至少两个 assistant 起始轮次，且至少一条 assistant。
// 只有单轮或纯用户消息时返回 false，避免摘要模型没有可总结的往返过程。
// 空数组、全前缀消息均返回 false；本函数无副作用，仅做分组和存在性判断。
export function hasEnoughMessagesToCompact(messages: readonly CompactModelMessage[]): boolean {
  const messagesToSummarize = getMessagesToSummarize(messages);
  return (
    // 两个轮次保证摘要至少覆盖一次“模型回复 + 后续输入”的上下文，而不是单条孤立消息。
    groupMessagesByCompactRound(messagesToSummarize).length >= 2 &&
    messagesToSummarize.some((message) => message.role === "assistant")
  );
}

// 把显式输入映射成可持久化的 compact 边界记录，是 compact 结果与会话恢复之间的契约。
// 缺失的可选字段按字段语义处理：trigger 默认 Manual，keptMessageCount 默认 0，customInstructions 只落布尔标记；
// 其余 undefined 字段原样写入，由消费方按“未知”处理，不在这里伪造默认值。
// preCompactDiscoveredTools 仅在非空时写入，避免空数组覆盖恢复侧原有的工具发现结果。
// 无 IO、无日志；返回新对象，summaryMessageIds 固定包装单个 summaryMessageId。
export function buildManualCompactBoundary(
  input: BuildManualCompactBoundaryInput,
): CompactBoundaryPayload {
  return {
    boundaryId: input.boundaryId,
    // 空数组不写入，保持字段缺失即“未上报”的语义，避免恢复时误判工具清单为空。
    ...(input.preCompactDiscoveredTools
      ? { preCompactDiscoveredTools: input.preCompactDiscoveredTools }
      : {}),
    trigger: input.trigger ?? CompactTrigger.Manual,
    phase: input.phase,
    compactReason: input.compactReason,
    summarySource: "model",
    preCompactTokenCount: input.preCompactTokenCount,
    postCompactTokenCount: input.postCompactTokenCount,
    truePostCompactTokenCount: input.truePostCompactTokenCount,
    autoCompactThreshold: input.autoCompactThreshold,
    willRetriggerNextTurn: input.willRetriggerNextTurn,
    summarizedMessageCount: input.summarizedMessageCount,
    keptMessageCount: input.keptMessageCount ?? 0,
    lastSummarizedMessageId: input.lastSummarizedMessageId,
    preservedSegment: input.preservedSegment,
    summaryMessageIds: [input.summaryMessageId],
    customInstructions: input.customInstructions !== undefined,
    traceId: input.traceContext.traceId,
    turnId: input.traceContext.turnId,
  };
}

// 本地近似估算消息总 token：按每个消息的 content 投影字符数加上 toolCalls 的 name/input 字符数，
// 再以 ESTIMATED_TOKEN_CHAR_DIVISOR 折算并逐条向上取整。结果不含 provider 缓存/图片真实 token，只用于阈值判断。
// 空数组返回 0；入参只读。工具入参序列化异常时按 "{}" 估算，保证估算不中断。
// 每条消息至少贡献 0，最终结果单调非负；不会触发 IO 或网络。
export function estimateMessageTokens(messages: readonly CompactModelMessage[]): number {
  return messages.reduce((total, message) => {
    let estimatedCharacterCount = modelMessageContentToTokenEstimateText(message.content).length;
    // assistant toolCalls 独立保存在 content 之外，旧估算只读取 content，
    // 大型工具入参会被完整发给 provider，却在 auto compact 和 preflight 中计为 0。
    for (const toolCall of message.toolCalls ?? []) {
      estimatedCharacterCount += (
        toolCall.name + stringifyToolCallInputForTokenEstimate(toolCall.input)
      ).length;
    }
    return total + Math.ceil(estimatedCharacterCount / ESTIMATED_TOKEN_CHAR_DIVISOR);
  }, 0);
}

function stringifyToolCallInputForTokenEstimate(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? EMPTY_TOOL_CALL_INPUT_JSON;
  } catch {
    // tool_use 解析失败时降级为空对象的 JSON 表示，供 estimator 估算。
    // ZCode 的模型输入仍可能包含未知内容；异常输入不能让本地预算估算中断 compact。
    return EMPTY_TOOL_CALL_INPUT_JSON;
  }
}

function modelMessageContentToTokenEstimateText(content: ModelMessageContent): string {
  if (typeof content === "string") return content;

  // modelMessageContentToText 是“可见正文”投影，会有意隐藏 reasoning；
  // compact fallback 却把它当作 provider 上下文体积，导致无 usage anchor 时 reasoning 全部计 0。
  // token 估算使用独立投影，避免改变正文、memory、错误文案等既有消费者的语义。
  return content
    .map((block) =>
      block.type === "reasoning" ? block.text : modelMessageContentBlockToText(block),
    )
    .filter(Boolean)
    .join("\n\n");
}

function isContextPrefixMessage<T extends CompactModelMessage>(message: T): boolean {
  return (
    message.role === "system" ||
    (message.role === "user" &&
      modelMessageContentToText(message.content).trimStart().startsWith("<system-reminder>"))
  );
}

function groupMessagesByCompactRound<T extends CompactModelMessage>(messages: readonly T[]): T[][] {
  return groupByAssistantStartedRounds(messages, (message) => message.role);
}

// 计算 usage 的总 token，优先级为 provider totalTokens > (input + output)。
// inputTokens 缺失时用 cacheRead + cacheWrite 兜底；若三者都缺失，输入侧按 0 处理，因此 undefined usage 返回 0。
// totalTokens 为 0 也视为有效上报，不再重新求和；所有分支结果均为非负整数（信任上游）。
// 纯读取，无副作用；reasoningTokens 不参与计算，避免重复计数。
export function getUsageTotalTokens(usage?: TokenUsageLike): number {
  const inputTokens =
    usage?.inputTokens ?? (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
  return usage?.totalTokens ?? inputTokens + (usage?.outputTokens ?? 0);
}

// 生成带固定前缀的 compact 边界 id；默认使用 crypto.randomUUID，便于测试注入确定性 id。
// 返回值形如 compact_<uuid>，非空；注入函数抛错时会原样向上传播，不在此吞掉。
// 本函数不负责持久化，也不检查同一会话内是否重复。
export function createCompactBoundaryId(
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  return `compact_${randomUUID()}`;
}
