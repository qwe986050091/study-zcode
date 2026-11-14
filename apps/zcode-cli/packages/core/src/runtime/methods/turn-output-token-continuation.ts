/**
 * ============================================================================
 * turn-output-token-continuation.ts —— 输出截断续写 + turn-local 历史提交工具
 * ============================================================================
 *
 * 【输出截断续写】
 *   模型因 max output 被截断(finishReason=length / max_tokens 等)时,不直接报错,
 *   而是最多再发 3 次"继续"请求:追加一条带 queryScope=output_token_continuation
 *   的 user 消息,让模型从中断处继续。达到上限后按输出上限错误收口。
 *   关键约束:续写提示是 query-local 的,不能进入持久化轨迹
 *   (filterOutputTokenContinuationEntries 负责剔除)。
 *
 * 【turn-local 历史提交】
 *   turnRequestState.entries 是本轮请求的 provider-visible 历史;
 *   commitTurnRequestEntries = 写入 canonical messageHistory + 同步本轮数组;
 *   appendTurnRequestEntries  = 只追加本轮数组(不写 canonical)。
 *   两者必须成对使用,避免"内存历史与持久化历史"出现两条写入路径。
 * ============================================================================
 */
import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { toTokenUsageInfo } from "../helpers/index.js";
import {
  countContextPrefixMessages,
  createRuntimeAssistantEntry,
  createRuntimeUserEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { RegularTurnLoopState, TurnRequestState } from "./turn-loop-state.js";

export const OUTPUT_TOKEN_CONTINUE_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";

export const OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE =
  "The model's response exceeded the output token maximum.";

// 次数上限取 3:每次续写都是一次完整请求(重新计费、可能再次超窗),
// 3 次足以覆盖"长答案被切"的常见情形,同时避免无限续写把 turn 拖死。
// 压缩请求与异常重试不计入这 3 次(见 isOutputTokenLimitFinishReason 的说明)。
const MAX_OUTPUT_TOKEN_CONTINUATIONS = 3;
// rawFinishReason 因 provider 而异:Anthropic 用 max_tokens,部分网关用
// max_output_tokens/model_context_window_exceeded。三者都归为"输出被截断"。
const OUTPUT_LIMIT_RAW_REASONS = new Set([
  "max_tokens",
  "max_output_tokens",
  "model_context_window_exceeded",
]);

/** 续写预算决策:有工具调用→none;非输出截断→none;否则按已用次数决定 continue/exhausted。 */
type OutputTokenContinuationDecision = "continue" | "exhausted" | "none";

export function classifyOutputTokenContinuation(input: {
  finishReason: string | undefined;
  rawFinishReason: string | undefined;
  toolCallCount: number;
  continuationCount: number;
}): OutputTokenContinuationDecision {
  // 带工具调用时绝不续写:tool_call 已经构成完整的执行意图,
  // 再追加"继续"会让模型在工具结果回来之前继续产出文本/重复调用,
  // 破坏 call/result 配对。此时即使截断也直接进入正常工具批次。
  if (input.toolCallCount > 0) return "none";
  // 非"输出被截断"的结束原因不续写:正常 stop/工具/内容过滤各有既定收口,
  // 额外追加"继续"只会污染历史。
  if (!isOutputTokenLimitFinishReason(input.finishReason, input.rawFinishReason)) {
    return "none";
  }
  // exhausted 不等于失败:调用方会把它收口成"输出上限"错误,
  // 让用户/上层看到明确的终止原因,而不是静默截断。
  return input.continuationCount < MAX_OUTPUT_TOKEN_CONTINUATIONS ? "continue" : "exhausted";
}

/**
 * 判断 finishReason 是否属于"输出被截断"。
 * 注意 model_context_window_exceeded 在成功响应里表示"生成填满窗口被截断",
 * 属于可续写的输出上限,而不是输入超窗;后者由 reactive compact 处理。
 */
export function isOutputTokenLimitFinishReason(
  finishReason: string | undefined,
  rawFinishReason: string | undefined,
): boolean {
  // 有意设计（非 Bug）：成功响应的 model_context_window_exceeded 属于 Continue。

  // 即使 content 全空也共享最多 3 次恢复;
  // Anthropic 允许 input 未超窗但 input + max_tokens 超窗；生成填满窗口会截断成功响应，
  // 这不等同于 input 本身超窗导致的请求失败，不能仅按名称转成异常并抢先 Reactive Compact。
  // 行为差异：之前见该成功 stop reason 就尝试 Reactive Compact；现在先保存 partial、
  // 追加 Continue，再回到 outer loop 检查 Micro/Auto Compact，需要时压缩后发起续写。
  // 续写若抛出真实超窗异常，Reactive Compact 成功后重试当前续写，无法恢复则报错；
  // 压缩既不额外追加 Continue，也不重置已用次数，三次限制不包含压缩请求和异常重试。
  // 第四次仍为成功截断时按输出上限报错，不再额外尝试一次 Reactive Compact。
  // 因此，若服务端持续返回该标记而本地自动压缩未触发，可能多次无效续写后耗尽；
  // 此取舍保留了先续写、按需压缩的原约定，不保证下一次续写一定成功。
  return finishReason === "length" || OUTPUT_LIMIT_RAW_REASONS.has(rawFinishReason ?? "");
}

function createOutputTokenContinuationEntry(): RuntimeMessageEntry {
  return {
    ...createRuntimeUserEntry(OUTPUT_TOKEN_CONTINUE_PROMPT),
    queryScope: "output_token_continuation",
  };
}

function isOutputTokenContinuationEntry(entry: RuntimeMessageEntry): boolean {
  // 排除 attachment:附件理论上不该带 queryScope,这里防的是"未来某类附件
  // 复用了同名字段"导致把真实附件误删。只在 message(kind !== attachment)上认标记。
  return entry.kind !== "attachment" && entry.queryScope === "output_token_continuation";
}

/**
 * 剔除 query-local 的续写提示,得到"可持久化/可记录"的条目集合。
 * 如果从未出现过续写提示,直接返回原数组(引用相等,调用方可据此跳过重渲染)。
 * 引用相等是契约的一部分:调用方用 `filtered === entries` 判断是否需要重建历史,
 * 所以这里不能无条件返回新数组。
 */
export function filterOutputTokenContinuationEntries(
  entries: readonly RuntimeMessageEntry[],
): readonly RuntimeMessageEntry[] {
  const firstContinuation = entries.findIndex(isOutputTokenContinuationEntry);
  if (firstContinuation < 0) return entries;
  return entries.filter((entry) => !isOutputTokenContinuationEntry(entry));
}

/**
 * 用当前 canonical 的 context prefix 替换 turn-local 条目的前缀。
 * 用于"压缩期间配置刷新已替换前缀"的场景:整体回写 turn-local 历史会撤销刷新,
 * 因此只提交转换后的对话尾部,前缀始终取 canonical 的最新版本。
 */
export function preserveCanonicalContextPrefix(
  currentCanonicalEntries: readonly RuntimeMessageEntry[],
  turnLocalEntries: readonly RuntimeMessageEntry[],
): readonly RuntimeMessageEntry[] {
  // 配置刷新会立即替换 canonical prefix，而恢复链继续持有原子 Turn 的旧
  // prefix。turn-local Compact 若整体回写会撤销刷新，因此只提交转换后的 conversation tail。
  return [
    ...currentCanonicalEntries.slice(0, countContextPrefixMessages(currentCanonicalEntries)),
    ...turnLocalEntries.slice(countContextPrefixMessages(turnLocalEntries)),
  ];
}

export function appendTurnRequestEntries(
  state: TurnRequestState,
  entries: readonly RuntimeMessageEntry[],
): void {
  if (entries.length === 0) return;
  state.entries = [...state.entries, ...entries];
}

/**
 * 提交条目:同时写入 canonical messageHistory 与本轮 turn-local 数组。
 * 三处调用方(turn-loop 的 reminder、工具结果、assistant 提交)都通过它落历史,
 * 保证"provider 看到的历史"与"持久化历史"同步推进。
 */
export function commitTurnRequestEntries(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  entries: readonly RuntimeMessageEntry[],
): void {
  // 两处写入必须成对:先写 canonical 再同步 turn-local,保证"provider 看到的"与
  // "持久化的"同源;空数组直接返回,避免无意义的事件/检查点写入。
  if (entries.length === 0) return;
  runtime.messageHistory.addEntries(entries);
  appendTurnRequestEntries(state, entries);
}

/**
 * 把模型响应提交为 assistant 条目。没有任何内容(无文本/推理/工具调用)时返回 false,
 * 交由调用方决定是否补空 assistant 或回滚。
 * 模型归因使用本轮绑定的 state.model,不信任 provider 返回的模型元数据。
 */
export function commitAssistantToTurnRequest(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  result: RuntimeModelTextResult,
  toolCalls: Parameters<typeof createRuntimeAssistantEntry>[1],
): boolean {
  const reasoning = result.reasoning?.filter(hasAssistantReasoningContent);
  const hasAssistantContent =
    state.modelResponse.length > 0 || (reasoning?.length ?? 0) > 0 || (toolCalls?.length ?? 0) > 0;
  if (!hasAssistantContent) return false;
  // provider result metadata 可能报告别的模型；assistant 归因必须使用
  // Turn 已绑定的 Model，避免恢复链重新引入旧的 provider-owned 模型身份。
  const modelRef = { providerId: state.model.providerId, modelId: state.model.modelId };
  commitTurnRequestEntries(runtime, state.turnRequestState, [
    createRuntimeAssistantEntry(
      state.modelResponse,
      toolCalls,
      reasoning,
      modelRef,
      toTokenUsageInfo(result.usage),
    ),
  ]);
  return true;
}

export function hasAssistantReasoningContent(
  reasoning: NonNullable<RuntimeModelTextResult["reasoning"]>[number],
): boolean {
  return reasoning.text.length > 0 || Object.keys(reasoning.providerOptions ?? {}).length > 0;
}

/** 追加一次续写提示并累加计数;该提示带 queryScope,请求结束后会被过滤掉。 */
export function appendOutputTokenContinuation(state: TurnRequestState): void {
  // 先追加带 queryScope 的提示再计数:两者必须成对,否则过滤后计数与条目错位,
  // 会出现"预算已耗尽但历史里没有续写提示"的状态(§6-9)。
  appendTurnRequestEntries(state, [createOutputTokenContinuationEntry()]);
  state.outputTokenContinuationCount += 1;
}

/** 结束续写恢复:把计数归零,表示下一次截断可以重新获得完整续写预算。 */
export function completeOutputTokenRecovery(state: TurnRequestState): void {
  state.outputTokenContinuationCount = 0;
}

/** turn 收尾时的清理别名:与 completeOutputTokenRecovery 语义一致。 */
export function finishOutputTokenRecovery(state: TurnRequestState): void {
  completeOutputTokenRecovery(state);
}
