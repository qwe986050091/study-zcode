// ============================================================
// ==== model/reasoning-history-normalization ====
// ============================================================
// 定位：请求前对历史消息做 reasoning/thinking 块的结构清理与签名兼容修复。
// 输入：ModelInputMessage 数组 + 可选目标模型（modelId/providerId）；函数均为纯函数。
// 输出：新的消息数组或原数组引用（无改动时保持同一引用，供调用方判等跳过）。
// 副作用：无 IO、无网络；只做浅拷贝 + 局部重建消息/内容数组。
// 失败语义：不抛错；签名拒绝修复函数通过返回 undefined 表示“本轮不适用，不可重试”。
// 不变量：消息顺序与轮次边界不被结构清理改变；只删除 reasoning 块，绝不改写 text/tool 语义；
//   只有确实发生删除时才创建新数组，避免无谓重投影。

import type {
  ModelInputMessage,
  ModelMessageContent,
  ModelMessageContentBlock,
  ModelReasoningContentBlock,
  ModelId,
  ModelProviderId,
} from "@zcode/contracts";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { getStatusCode, unwrapRetryError } from "./failure-inspection.js";

const EMPTY_ASSISTANT_CONTENT_FALLBACK = "(no content)";
const REJECTED_REASONING_FALLBACK = "[Thinking removed]";

// 旧历史保留 builtin 身份，当前选型已迁到 account 身份；Individual/Team
// 也会使用不同 ID。只在 reasoning 回放时识别同服务的这些明确身份，不改变选型或鉴权。
// 不能复用套餐展示分组：Start/Off-Peak/API 接入不在这份签名兼容范围内。
// 同组内 provider 的 thinking 签名可互通，跨组则必须丢弃签名块。
const REASONING_PROVIDER_GROUPS: readonly (readonly string[])[] = [
  [
    "builtin:zai-coding-plan",
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
  ],
  [
    "builtin:bigmodel-coding-plan",
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
  ],
];

/**
 * reasoning 历史主入口：按固定顺序执行跨模型签名剔除、孤儿/尾部 reasoning 清理、
 * 空白 assistant 合并与空内容修补，产出可安全回放的消息序列。
 * 输入：messages（可空数组）+ 目标模型（缺省时不做跨模型剔除）。
 * 输出：清理后的数组；各 pass 无改动时逐级返回原引用。
 * 副作用：无；所有 pass 均返回新数组或原数组，不就地修改消息。
 * 不变量：pass 顺序固定——先删签名块再删仅 reasoning 的消息，最后才补占位，
 *   保证被删空的 assistant 不会先被补成 "(no content)" 再删掉。
 */
export function normalizeReasoningHistory(
  messages: ModelInputMessage[],
  targetModel?: { modelId: ModelId; providerId: ModelProviderId },
): ModelInputMessage[] {
  const compatibleHistory = removeCrossModelReasoning(messages, targetModel);
  const withoutOrphans = removeReasoningOnlyAssistants(compatibleHistory);
  const withoutTrailingReasoning = removeTrailingReasoning(withoutOrphans);
  const withoutWhitespaceOnlyAssistants = removeWhitespaceOnlyAssistants(withoutTrailingReasoning);
  return repairEmptyAssistantContent(withoutWhitespaceOnlyAssistants);
}

/**
 * 删除所有带签名的 reasoning 块（针对 provider 明确拒绝签名后的重试路径）。
 * 输入：逻辑请求入口已归一化的消息副本。
 * 输出：新数组；无签名块时返回原引用。
 * 不变量：若某条 assistant 因此只剩 reasoning 且无 toolCalls，补 "[Thinking removed]"
 *   文本占位，避免出现空 assistant 消息导致轮次结构非法。
 */
export function removeRejectedReasoning(messages: ModelInputMessage[]): ModelInputMessage[] {
  const filtered = filterReasoningBlocks(messages, isSignedOrRedactedReasoning);
  if (filtered === messages) return messages;

  const result = filtered.slice();
  for (let index = 0; index < filtered.length; index += 1) {
    if (filtered[index] === messages[index]) continue;

    const message = filtered[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    let content = message.content.filter(
      (block) => block.type !== "text" || block.text.trim().length > 0,
    );
    if (!hasToolCalls(message) && content.every((block) => block.type === "reasoning")) {
      content = [...content, { type: "text", text: REJECTED_REASONING_FALLBACK }];
    }
    result[index] = { ...message, content };
  }
  return result;
}

/**
 * 判断签名拒绝错误是否适用“删签名后重试”，适用则返回修复后的消息。
 * 输出：undefined 表示不适用（调用方不得重试）；否则返回清理过的副本。
 * 失败语义：不抛错，错误形状无法识别时保守返回 undefined，避免误改历史。
 * 不变量：只执行签署清理，不重跑结构 pass，防止删除刚补出的占位并改变轮次边界。
 */
export function repairReasoningHistoryAfterSignatureRejection(
  projectedMessages: ModelInputMessage[],
  error: unknown,
): ModelInputMessage[] | undefined {
  if (!isThinkingSignatureRejection(error)) return undefined;

  // 调用方传入的已经是逻辑请求入口完成结构归一化后的副本。这里仅执行签名拒绝清理，
  // 不能再次运行结构 passes，否则会删除刚补出的 assistant 占位并改变轮次边界。
  const repaired = removeRejectedReasoning(projectedMessages);
  return repaired === projectedMessages ? undefined : repaired;
}

/**
 * 识别 Anthropic 的 thinking 签名拒绝错误（HTTP 400 + 特定文案组合）。
 * 输入：可能被 retry 包装的错误；内部先 unwrapRetryError 再看 status。
 * 输出：true 表示可尝试删签名重试；false 表示与其他 400 无法区分，保持原样失败。
 */
export function isThinkingSignatureRejection(error: unknown): boolean {
  const unwrapped = unwrapRetryError(error);
  if (getStatusCode(unwrapped) !== 400) return false;

  // Provider 没有为该 400 提供独立错误码；这里只匹配已确认的窄化文案，
  // 避免把其他 invalid_request 误当成可修改历史并重试。
  const message = errorMessage(unwrapped).toLowerCase();
  if (message.includes("signature in thinking block")) return true;

  const namesThinkingBlock =
    message.includes("thinking block") ||
    message.includes("`thinking`") ||
    message.includes("redacted_thinking");
  const namesSignatureFailure =
    message.includes("cannot be modified") || message.includes("invalid signature");
  return namesThinkingBlock && namesSignatureFailure;
}

/**
 * 剔除与目标模型不兼容的签名 reasoning 块；缺省目标模型时原样返回（无从判断兼容性）。
 * 只删除 signed/redacted 块，未签名 reasoning 不参与跨模型判定。
 */
function removeCrossModelReasoning(
  messages: ModelInputMessage[],
  targetModel: { modelId: ModelId; providerId: ModelProviderId } | undefined,
): ModelInputMessage[] {
  if (!targetModel) return messages;

  return filterReasoningBlocks(messages, (block, message) => {
    if (!message.providerId || !message.modelId) return false;
    if (
      message.modelId === targetModel.modelId &&
      areReasoningProvidersCompatible(message.providerId, targetModel.providerId)
    ) {
      return false;
    }
    return isSignedOrRedactedReasoning(block);
  });
}

/** provider 相同或落在同一 reasoning 签名互通组内即视为兼容。 */
function areReasoningProvidersCompatible(
  source: ModelProviderId,
  target: ModelProviderId,
): boolean {
  return (
    source === target ||
    REASONING_PROVIDER_GROUPS.some((group) => group.includes(source) && group.includes(target))
  );
}

/**
 * 通用 reasoning 过滤：对每条 assistant 消息按谓词删除指定 reasoning 块。
 * 输出：发生改动时返回新数组（首个改动处才复制），否则原引用；非 assistant/非数组内容直接跳过。
 */
function filterReasoningBlocks(
  messages: ModelInputMessage[],
  shouldRemove: (block: ModelReasoningContentBlock, message: ModelInputMessage) => boolean,
): ModelInputMessage[] {
  let result: ModelInputMessage[] | undefined;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    const content = message.content.filter(
      (block) => block.type !== "reasoning" || !shouldRemove(block, message),
    );
    if (content.length === message.content.length) continue;

    result ??= messages.slice();
    // 此处只过滤 reasoning block，保留消息顺序与结构；结构修复由独立阶段处理。
    result[index] = { ...message, content };
  }

  return result ?? messages;
}

/**
 * 删除“只剩 reasoning 且无 toolCalls”的 assistant 消息；带工具调用的消息必须保留以维持配对。
 */
function removeReasoningOnlyAssistants(messages: ModelInputMessage[]): ModelInputMessage[] {
  const result = messages.filter((message) => {
    if (message.role !== "assistant" || hasToolCalls(message)) return true;
    if (!Array.isArray(message.content) || message.content.length === 0) return true;
    return !message.content.every((block) => block.type === "reasoning");
  });
  return result.length === messages.length ? messages : result;
}

/**
 * 删除最后一条 assistant 消息尾部的连续 reasoning 块（末尾 thinking 不能作为续写起点）。
 * 输出：无尾部 reasoning 或末条不是 assistant 时返回原引用。
 */
function removeTrailingReasoning(messages: ModelInputMessage[]): ModelInputMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return messages;

  let end = last.content.length;
  while (end > 0 && last.content[end - 1]?.type === "reasoning") {
    end -= 1;
  }
  if (end === last.content.length) return messages;

  const result = messages.slice();
  result[result.length - 1] = {
    ...last,
    content: last.content.slice(0, end),
  };
  return result;
}

/**
 * 删除仅含空白文本或 "(no content)" 占位的 assistant 消息，并合并因此相邻的 user 消息。
 * 返回原引用表示无删除；有删除时一定执行 user 相邻合并，避免留下断裂的轮次。
 */
function removeWhitespaceOnlyAssistants(messages: ModelInputMessage[]): ModelInputMessage[] {
  const filtered = messages.filter((message) => {
    if (message.role !== "assistant" || hasToolCalls(message)) return true;
    if (!Array.isArray(message.content) || message.content.length === 0) return true;
    return !message.content.every(
      (block) =>
        block.type === "text" &&
        (block.text.trim().length === 0 || block.text.trim() === EMPTY_ASSISTANT_CONTENT_FALLBACK),
    );
  });
  if (filtered.length === messages.length) return messages;
  return mergeAdjacentUserMessages(filtered);
}

/**
 * 为“内容为空且无 toolCalls”的 assistant 补 "(no content)" 文本，保持 assistant 轮次存在。
 * 只处理非最后一条消息：末条空 assistant 正等待生成，不应填充占位。
 */
function repairEmptyAssistantContent(messages: ModelInputMessage[]): ModelInputMessage[] {
  let result: ModelInputMessage[] | undefined;

  for (let index = 0; index < messages.length - 1; index += 1) {
    const message = messages[index]!;
    if (
      message.role !== "assistant" ||
      !Array.isArray(message.content) ||
      message.content.length > 0 ||
      hasToolCalls(message)
    ) {
      continue;
    }

    result ??= messages.slice();
    result[index] = {
      ...message,
      content: [{ type: "text", text: EMPTY_ASSISTANT_CONTENT_FALLBACK }],
    };
  }

  return result ?? messages;
}

/**
 * 合并相邻的普通 user 消息（tool result 消息不参与，必须与其 toolCall 保持一一对应）。
 * 输出：新数组；cacheControl 取后者优先、缺省沿用前者，避免丢失缓存指令。
 */
function mergeAdjacentUserMessages(messages: ModelInputMessage[]): ModelInputMessage[] {
  const result: ModelInputMessage[] = [];

  for (const message of messages) {
    const previous = result.at(-1);
    if (!canMergeAdjacentUserMessages(previous, message)) {
      result.push(message);
      continue;
    }

    const merged: ModelInputMessage = {
      role: "user",
      content: mergeUserContent(previous.content, message.content),
    };
    const cacheControl = message.cacheControl ?? previous.cacheControl;
    if (cacheControl) merged.cacheControl = { ...cacheControl };
    result[result.length - 1] = merged;
  }

  return result;
}

/** 判断前后两条是否都是非 tool-result 的普通 user 消息，可作为类型守卫收窄 previous。 */
function canMergeAdjacentUserMessages(
  previous: ModelInputMessage | undefined,
  next: ModelInputMessage,
): previous is ModelInputMessage & { role: "user" } {
  if (previous?.role !== "user" || next.role !== "user") return false;
  return !isToolResultUserMessage(previous) && !isToolResultUserMessage(next);
}

/** tool result 承载于 user 角色上，通过 toolCallId/toolName 与普通 user 文本区分。 */
function isToolResultUserMessage(message: ModelInputMessage): boolean {
  return message.role === "user" && Boolean(message.toolCallId || message.toolName);
}

/**
 * 拼接两段 user 内容为块数组；若两侧首尾都是文本，在交界处补 "\n" 防止文字粘连。
 * 输入字符串会先包装为单个 text 块，输入数组则浅拷贝避免复用可变数组。
 */
function mergeUserContent(
  previous: ModelMessageContent,
  next: ModelMessageContent,
): ModelMessageContentBlock[] {
  const previousBlocks = contentAsBlocks(previous);
  const nextBlocks = contentAsBlocks(next);
  const previousLast = previousBlocks.at(-1);
  const nextFirst = nextBlocks[0];

  if (previousLast?.type === "text" && nextFirst?.type === "text") {
    previousBlocks[previousBlocks.length - 1] = {
      ...previousLast,
      text: `${previousLast.text}\n`,
    };
  }

  return [...previousBlocks, ...nextBlocks];
}

/** 把字符串内容包装为 text 块数组，数组内容复制一份以隔离调用方引用。 */
function contentAsBlocks(content: ModelMessageContent): ModelMessageContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

/** 带 Anthropic signature 或 redactedData 的 reasoning 块才跨模型不可复用。 */
function isSignedOrRedactedReasoning(block: ModelReasoningContentBlock): boolean {
  const anthropic = anthropicOptions(block.providerOptions);
  return (
    (typeof anthropic.signature === "string" && anthropic.signature.length > 0) ||
    typeof anthropic.redactedData === "string"
  );
}

/** 是否带工具调用；决定该 assistant 消息能否被安全删除。 */
function hasToolCalls(message: ModelInputMessage): boolean {
  return (message.toolCalls?.length ?? 0) > 0;
}

/** 安全取出 providerOptions.anthropic 子对象；非对象形状统一归一为空对象。 */
function anthropicOptions(providerOptions: unknown): Record<string, unknown> {
  if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) {
    return {};
  }
  const anthropic = (providerOptions as Record<string, unknown>).anthropic;
  return anthropic && typeof anthropic === "object" && !Array.isArray(anthropic)
    ? (anthropic as Record<string, unknown>)
    : {};
}

/** 从任意错误值提取可用于文案匹配的 message，兼容 Error、对象与字符串。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error ?? "");
}
