/**
 * ============================================================================
 * provider-request-messages.ts —— provider 中性消息投影(核心渲染器)
 * ============================================================================
 *
 * 【输入】RuntimeMessageEntry(turn-local 或 canonical 历史)
 * 【输出】ProviderRequestMessageProjectionResult:
 *   messages        provider 可直接发送的 ModelInputMessage[]
 *   sourceEntries   每条投影消息对应的原始 entry(usage 归属/token 估算)
 *   diagnostics     附件上浮数量、latest real user 索引、cacheControl 位置等
 *
 * 【投影步骤】
 *   1. 记录来源(origins)并统计 presented input;
 *   2. 相邻附件上浮到最近的 user 边界(保持因果顺序,部分 source 除外);
 *   3. mid-conversation system:把部分系统提醒投影到对话中间(模型支持时);
 *   4. 旧式 system reminder 移到 tool result 连续段之后;
 *   5. 渲染为 provider 消息(剥离 runtime metadata,只保留模型可见内容);
 *   6. 追加 ToolSearch 成功提示;
 *   7. 按需在最新非 system 消息上设置 cacheControl(在投影之后,避免锚点被合成条目抢占)。
 *
 * 【不变量】
 * - sourceEntries 与 messages 一一对齐；indexMap 把投影前索引(含 latest real user)
 *   重映射到投影后，未命中的映射记为 -1，交给调用方按"没有真实用户"处理；
 * - latestRealUserMessageIndex 必须在剥离 metadata 之前计算：用户字面写的
 *   system-reminder 文本在 metadata 剥离后就与真正的 meta 无法区分；
 * - cacheControl 是最后一步写入，避免被 ToolSearch 成功提示或合成的 MCS 消息抢占锚点；
 * - 本函数保持 provider-neutral，不做 Anthropic 专属的相邻 user 合并。
 * ============================================================================
 */
import {
  ProviderEntryOrigins,
  isPresentedInput,
  projectIncomingMessageEntries,
} from "./provider-entry-origins.js";
import {
  projectMidConversationSystemEntries,
  moveLegacySystemRemindersAfterToolResultRun,
  isToolResultUserMessage,
  type ProjectedRuntimeMessageEntry,
} from "./provider-mid-conversation-system.js";
import type { ModelMessageContent, ModelMessageContentBlock } from "@zcode/contracts";
import type { ModelInputMessage, RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  cloneModelInputMessage,
  toModelToolCall,
  cloneModelMessageContent,
  isKnownSystemReminderSource,
  isRuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import {
  getSystemReminderDescriptor,
  isMidConversationSystemSource,
  wrapSystemReminderForSource,
  type SystemReminderSource,
} from "../../system-reminder/source.js";

/**
 * provider 请求消息的投影结果。
 *
 * 字段口径：
 * - messages：可直接发送给 provider 的消息；runtime metadata 已剥离；
 * - sourceEntries：与 messages 下标一一对应，值是该消息的代表性 canonical 条目，
 *   仅用于 usage 归属/token 估算，不会进入请求体；合成消息可能为 undefined；
 * - diagnostics.bubbledAttachmentEntryCount：被上浮到 user 边界的附件条目数；
 * - diagnostics.latestRealUserMessageIndex：投影后最新真实 user 的位置，-1 表示明确没有；
 * - diagnostics.strippedRuntimeMetaCount：输入条目中带 metadata 的条目数（投影前口径）；
 * - diagnostics.cacheControlIndex：实际写入 cacheControl 的消息下标，未写入时缺省。
 */
export interface ProviderRequestMessageProjectionResult {
  messages: ModelInputMessage[];
  /** 仅用于内部归属；runtime metadata 不会进入 `messages`。 */
  sourceEntries: Array<RuntimeMessageEntry | undefined>;
  diagnostics: {
    bubbledAttachmentEntryCount: number;
    latestRealUserMessageIndex?: number;
    strippedRuntimeMetaCount: number;
    cacheControlIndex?: number;
  };
}

// 相邻 user 合并是 Anthropic provider 的协议序列化责任；
// MCS/provider projection 保持 provider-neutral，避免影响 OpenAI-compatible 请求形态。
const ENABLE_MCS_ADJACENT_USER_MERGE = false;
const TOOL_SEARCH_LOADED_MESSAGE = "Tool loaded.";

// State changes must keep their causal position relative to older target continuations.
const NON_BUBBLING_ATTACHMENT_SOURCES: ReadonlySet<SystemReminderSource> = new Set([
  "goal_state_change",
]);

/**
 * 把 RuntimeMessageEntry 投影成 provider 消息数组。
 *
 * 注意:这里保持 provider-neutral,不做 Anthropic 专属的"相邻 user 合并"
 * (ENABLE_MCS_ADJACENT_USER_MERGE=false),合并责任留给具体 adapter。
 *
 * 输入:
 * - entries: turn-local 或 canonical 历史条目;
 * - applyCacheControl: 是否在最后写入 cache 锚点(只有正常请求为 true);
 * - skipCacheWrite: 辅助/compact 请求不写 cache,锚点前移一格;
 * - useMidConversationSystem: 默认 true,模型不支持时由上层显式关掉;
 * - loadedToolCallIds: 本次 ToolSearch 决策已加载的 toolCallId,用于派生成功提示。
 *
 * 处理顺序: incoming 投影 → 附件上浮 → MCS(可选) → legacy reminder 搬迁 →
 * 计算 latest real user → 渲染(剥离 metadata) → ToolSearch 提示 → cacheControl。
 *
 * 输出: messages 与 sourceEntries 等长; diagnostics 记录上浮数、索引与 cache 位置。
 * 副作用: 只写本次请求的 origins WeakMap; 渲染时 clone 入参消息,不改原条目。
 * 失败语义: attachment 来源未知时 renderProjectedEntryToModelMessage 会抛错——
 * 这类错误说明 canonical history 被写坏,不应静默降级。
 */
export function buildProviderRequestMessages(input: {
  entries: readonly RuntimeMessageEntry[];
  applyCacheControl?: boolean;
  skipCacheWrite?: boolean;
  useMidConversationSystem?: boolean;
  loadedToolCallIds?: ReadonlySet<string>;
}): ProviderRequestMessageProjectionResult {
  const useMidConversationSystem = input.useMidConversationSystem !== false;
  const origins = new ProviderEntryOrigins();
  const reorderResult = reorderAttachmentLikeEntries(
    projectIncomingMessageEntries(input.entries, origins),
  );
  const midSystemProjection = useMidConversationSystem
    ? projectMidConversationSystemEntries(reorderResult.entries, origins)
    : { entries: reorderResult.entries };
  const projectedEntries = moveLegacySystemRemindersAfterToolResultRun(midSystemProjection.entries);
  // media-budget 在 provider-clean messages 上运行，必须在剥离 metadata 前记录
  // latest real user 的 projection 后索引，避免用户 literal system-reminder 被误当成 meta。
  const latestRealUserMessageIndex = findLatestRealUserEntryIndex(projectedEntries, origins);
  const renderedMessages = projectedEntries.map(renderProjectedEntryToModelMessage);
  const mergeResult = ENABLE_MCS_ADJACENT_USER_MERGE
    ? mergeAdjacentUserMessages(renderedMessages)
    : appendToolSearchSuccessMessages(renderedMessages, input.loadedToolCallIds);
  const messages = mergeResult.messages;
  const sourceEntries: Array<RuntimeMessageEntry | undefined> = Array.from({
    length: messages.length,
  });
  for (const [projectedIndex, mergedIndex] of mergeResult.indexMap.entries()) {
    if (sourceEntries[mergedIndex] !== undefined) continue;
    const entry = projectedEntries[projectedIndex];
    if (entry) sourceEntries[mergedIndex] = origins.representative(entry);
  }
  const finalLatestRealUserMessageIndex =
    latestRealUserMessageIndex >= 0 ? (mergeResult.indexMap[latestRealUserMessageIndex] ?? -1) : -1;
  const cacheControlIndex =
    input.applyCacheControl === true
      ? finalizeLatestNonSystemMessageCacheControl(messages, {
          skipCacheWrite: input.skipCacheWrite === true,
        })
      : undefined;

  return {
    messages,
    sourceEntries,
    diagnostics: {
      bubbledAttachmentEntryCount: reorderResult.bubbledAttachmentEntryCount,
      // 新标记能证明“没有真实用户”；省略索引会让媒体预算按 user role 重新猜来源。
      ...(finalLatestRealUserMessageIndex >= 0 ||
      input.entries.some(isPresentedInput) ||
      input.loadedToolCallIds?.size
        ? { latestRealUserMessageIndex: finalLatestRealUserMessageIndex }
        : {}),
      strippedRuntimeMetaCount: input.entries.filter((entry) => entry.metadata).length,
      ...(cacheControlIndex !== undefined ? { cacheControlIndex } : {}),
    },
  };
}

/**
 * 附件上浮结果。
 *
 * - entries：重排后的条目，未上浮的条目保持原相对顺序；
 * - bubbledAttachmentEntryCount：被上浮的附件条目数，仅用于诊断。
 */
interface AttachmentReorderResult {
  entries: RuntimeMessageEntry[];
  bubbledAttachmentEntryCount: number;
}

/**
 * 把"附件型 user 条目"上浮到最近的 user 轮次开头。
 *
 * 原因：附件/系统提醒在 provider 侧也是 user 文本，若留在原位可能夹进 tool result
 * 段中间，造成 role 顺序非法；提前到 user 轮次前可作为 request prefix 使用。
 *
 * 算法（从后往前扫描 + 末尾整体 reverse）：
 * - 遇到附件型条目先放入 pending；
 * - 遇到 presented input 或真正的边界（system/assistant/tool/工具结果 user）时，
 *   把 pending 落位到该边界之后（forward 顺序里紧邻边界之后），并计数；
 * - 普通 user 文本不是边界，pending 会继续向前跨过它，最终落到该轮用户之前。
 *
 * 输出：新数组 + 上浮计数；不修改入参条目、不改变非附件条目之间的相对顺序。
 * 失败语义：纯内存重排，不抛错；尾部没有边界的附件留在数组末尾。
 */
function reorderAttachmentLikeEntries(
  entries: readonly RuntimeMessageEntry[],
): AttachmentReorderResult {
  const result: RuntimeMessageEntry[] = [];
  const pending: RuntimeMessageEntry[] = [];
  let bubbledAttachmentEntryCount = 0;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (isAttachmentLikeUserEntry(entry)) {
      pending.push(entry);
      continue;
    }

    if (
      (isPresentedInput(entry) ||
        (!isRuntimeAttachmentEntry(entry) && isBubbleStop(entry.message))) &&
      pending.length > 0
    ) {
      result.push(...pending);
      bubbledAttachmentEntryCount += pending.length;
      pending.length = 0;
    }
    result.push(entry);
  }

  if (pending.length > 0) {
    result.push(...pending);
    bubbledAttachmentEntryCount += pending.length;
  }

  result.reverse();
  return { entries: result, bubbledAttachmentEntryCount };
}

/**
 * 判断条目是否属于"应上浮的附件型 user 内容"。
 *
 * 三类排除：
 * - presented input 永不参与上浮（它本身就是因果边界，位置必须固定）；
 * - 非 user 消息、工具结果型 user；
 * - 真实用户（source=real_user 或无 metadata 的普通 user）。
 * attachment 与 legacy_synthetic 都要求 descriptor 满足：isMeta、provider_visible、
 * channel 不是 tool_result/real_user，且不是 history_continuity/MCS，也不是
 * NON_BUBBLING_ATTACHMENT_SOURCES 里的 source——这些 source 的因果位置必须保留。
 * 纯函数，无副作用。
 */
function isAttachmentLikeUserEntry(entry: RuntimeMessageEntry): boolean {
  if (isPresentedInput(entry)) return false;
  if (isRuntimeAttachmentEntry(entry)) {
    const source = entry.metadata.source;
    if (!isKnownSystemReminderSource(source)) return false;
    if (NON_BUBBLING_ATTACHMENT_SOURCES.has(source)) return false;
    const descriptor = getSystemReminderDescriptor(source);
    if (descriptor.channel === "history_continuity") return false;
    return (
      descriptor.isMeta &&
      descriptor.providerVisibility === "provider_visible" &&
      descriptor.channel !== "tool_result" &&
      descriptor.channel !== "real_user"
    );
  }

  if (entry.message.role !== "user") return false;
  if (isToolResultUserMessage(entry.message)) return false;
  const source = entry.metadata?.source;
  if (!source || source === "real_user") return false;
  if (source === "legacy_synthetic") return true;
  if (!isKnownSystemReminderSource(source)) return false;
  if (isMidConversationSystemSource(source)) return false;

  const descriptor = getSystemReminderDescriptor(source);
  if (descriptor.channel === "history_continuity") return false;
  return (
    descriptor.isMeta &&
    descriptor.providerVisibility === "provider_visible" &&
    descriptor.channel !== "tool_result" &&
    descriptor.channel !== "real_user"
  );
}

/**
 * 判断消息是否是附件上浮的"硬边界"：system/assistant/tool/工具结果 user。
 *
 * 这些 role 之后不能再插入普通 user 文本，否则 provider 序列化时会被合并到错误位置；
 * 普通 user 文本不在其中，因此附件可以继续跨过它落到轮次开头。纯函数。
 */
function isBubbleStop(message: ModelInputMessage): boolean {
  return (
    message.role === "system" ||
    message.role === "assistant" ||
    message.role === "tool" ||
    isToolResultUserMessage(message)
  );
}

/**
 * 把投影条目渲染成最终发给 provider 的消息。
 *
 * - attachment 条目：必须是已知 system reminder source，否则抛错（canonical history
 *   被写坏时不能静默发出去）；正文用 wrapSystemReminderForSource 包装，保证用户可见
 *   标签与转义口径一致，canonical 原文不受影响；
 * - 普通条目：clone 消息后恢复 provider 侧工具身份（toModelToolCall），并把
 *   modelCallWrapper 还原成 toolName 后删除内部字段，避免内部包装泄漏进请求体。
 * 副作用：只克隆、不修改入参；输出是新的 ModelInputMessage。
 * 失败语义：未知 attachment source 直接抛错（fail closed）。
 */
function renderProjectedEntryToModelMessage(
  entry: ProjectedRuntimeMessageEntry,
): ModelInputMessage {
  if (isRuntimeAttachmentEntry(entry)) {
    const source = entry.metadata.source;
    if (!isKnownSystemReminderSource(source)) {
      throw new Error(`Attachment source ${source} is not a system reminder source`);
    }
    const message: ModelInputMessage = {
      role: "user",
      // incoming 载荷也可能含关闭标签；统一在 provider 包装时转义，canonical 原文不变。
      content: wrapSystemReminderForSource(source, entry.content),
    };
    if (entry.cacheControl) {
      message.cacheControl = { ...entry.cacheControl };
    }
    return message;
  }
  const message = cloneModelInputMessage(entry.message);
  // 内部历史使用目标身份；只在现有 provider render 中恢复真实模型包装。
  for (let index = 0; index < (message.toolCalls?.length ?? 0); index++) {
    message.toolCalls![index] = toModelToolCall(message.toolCalls![index]!);
  }
  if (message.modelCallWrapper) {
    message.toolName = message.modelCallWrapper;
    delete message.modelCallWrapper;
  }
  return message;
}

/**
 * 消息合并/追加的结果。
 *
 * - messages：处理后的消息数组；
 * - indexMap：indexMap[i] 是"处理前第 i 条"在 messages 中的下标；未丢失时与 i 相同，
 *   合并时指向被合并到的位置。用于把 latest real user 等投影前索引重映射到最终数组。
 */
interface MessageMergeResult {
  messages: ModelInputMessage[];
  indexMap: number[];
}

/**
 * 合并相邻 user 消息（当前由 ENABLE_MCS_ADJACENT_USER_MERGE=false 关闭）。
 *
 * 存在的意义：Anthropic 协议要求相邻 user 文本合并，但该责任属于 provider adapter；
 * 这里保留实现以便未来切换，同时用 indexMap 维持投影前后索引映射。
 * 输出：messages 与 indexMap（indexMap[i] = 投影前第 i 条在合并后的下标）。
 */
function mergeAdjacentUserMessages(messages: readonly ModelInputMessage[]): MessageMergeResult {
  const merged: ModelInputMessage[] = [];
  const indexMap: number[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const previous = merged.at(-1);
    if (previous && canMergeAdjacentUserMessages(previous, message)) {
      const mergedIndex = merged.length - 1;
      merged[mergedIndex] = mergeUserMessages(previous, message);
      indexMap[index] = mergedIndex;
      continue;
    }

    indexMap[index] = merged.length;
    merged.push(message);
  }

  return { messages: merged, indexMap };
}

/**
 * 在 ToolSearch 已加载的工具结果整批结束后，追加 "Tool loaded." 提示。
 *
 * 输入：messages 是渲染后的请求消息；loadedToolCallIds 是本次决策加载的 toolCallId。
 * 规则：只有 tool result 连续段彻底结束、且该段中至少有一个已加载 id 时，才插入
 * 提示——插在段中间会把 tool result 拆开。indexMap 记录每条原消息在新数组的下标，
 * 后续 sourceEntries/latest real user 重映射依赖它。
 * 输出：新数组 + indexMap；无 loaded id 时返回浅拷贝与原样 indexMap。
 * 副作用：不修改入参消息。纯内存计算。
 */
function appendToolSearchSuccessMessages(
  messages: readonly ModelInputMessage[],
  loadedToolCallIds?: ReadonlySet<string>,
): MessageMergeResult {
  if (!loadedToolCallIds?.size)
    return { messages: [...messages], indexMap: messages.map((_, index) => index) };
  const result: ModelInputMessage[] = [];
  const indexMap: number[] = [];
  let pendingLoaded = 0;
  for (const [index, message] of messages.entries()) {
    indexMap.push(result.length);
    result.push(message);
    if (message.role === "tool" && message.toolCallId && loadedToolCallIds.has(message.toolCallId))
      pendingLoaded++;
    // 成功提示只在最终投影中派生；整批 tool result 必须连续，不能被提示拆开。
    if (messages[index + 1]?.role !== "tool") {
      while (pendingLoaded > 0) {
        result.push({ role: "user", content: TOOL_SEARCH_LOADED_MESSAGE });
        pendingLoaded--;
      }
    }
  }
  return { messages: result, indexMap };
}

/**
 * 判断两条相邻 user 消息是否可合并：必须都是 user，且都不是工具结果型 user。
 * 工具结果必须保持独立 role 段，合并会破坏 tool_call/tool_result 配对。纯函数。
 */
function canMergeAdjacentUserMessages(
  previous: ModelInputMessage,
  next: ModelInputMessage,
): boolean {
  if (previous.role !== "user" || next.role !== "user") return false;
  return !isToolResultUserMessage(previous) && !isToolResultUserMessage(next);
}

/**
 * 合并两条 user 消息：content 拼接，cacheControl 取 next 优先（保留更靠近尾部的锚点）。
 * 输出新对象，不修改入参。仅在 ENABLE_MCS_ADJACENT_USER_MERGE 打开时可达。
 */
function mergeUserMessages(
  previous: ModelInputMessage,
  next: ModelInputMessage,
): ModelInputMessage {
  const merged: ModelInputMessage = {
    role: "user",
    content: mergeUserContent(previous.content, next.content),
  };
  const cacheControl = next.cacheControl ?? previous.cacheControl;
  if (cacheControl) merged.cacheControl = { ...cacheControl };
  return merged;
}

/**
 * 合并两段 content：字符串先转 text 块，数组则 clone；若前后都以 text 结尾/开头，
 * 在拼接点补一个换行，避免两段文本黏在一起改变语义。纯函数，返回新数组。
 */
function mergeUserContent(
  previous: ModelMessageContent,
  next: ModelMessageContent,
): ModelMessageContentBlock[] {
  const previousBlocks = modelContentToMergeBlocks(previous);
  const nextBlocks = modelContentToMergeBlocks(next);
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

/**
 * 把任意 content 形态转成可合并的块数组：字符串包成单个 text 块，数组做深拷贝，
 * 保证合并时不会与入参共享块对象。纯函数。
 */
function modelContentToMergeBlocks(content: ModelMessageContent): ModelMessageContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return cloneModelMessageContent(content) as ModelMessageContentBlock[];
}

/**
 * 在投影后的条目里定位"最新真实 user"。
 *
 * 用 origins.hasRealUser 而不是 role 判断：MCS/tool 包装后的合成 user 不能算真实用户；
 * 返回最后一个命中的下标，无命中返回 -1（作为"明确没有真实用户"的正式表达）。
 * 纯函数，无副作用。
 */
function findLatestRealUserEntryIndex(
  entries: readonly ProjectedRuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): number {
  return entries.findLastIndex((entry) => origins.hasRealUser(entry));
}

/**
 * 确定 cacheControl 锚点并写入：先清空所有非 system 消息上的旧 marker，再在最新
 * 非 system 消息上设置 ephemeral。
 *
 * skipCacheWrite=true 时（compact/辅助请求）锚点再前移一格，避免把缓存写在
 * compact prompt 本身；找不到可锚定消息时返回 undefined 且不写 marker。
 * 副作用：原地修改 messages 数组中的消息对象（先清后设）。
 */
function finalizeLatestNonSystemMessageCacheControl(
  messages: ModelInputMessage[],
  options: { skipCacheWrite?: boolean } = {},
): number | undefined {
  clearNonSystemMessageCacheControl(messages);

  const latestIndex = findPreviousNonSystemMessageIndex(messages, messages.length - 1);
  if (latestIndex === undefined) return undefined;

  // 但不作为 cache write breakpoint，marker 应前移到 compact prompt 前的真实上下文。
  const cacheControlIndex =
    options.skipCacheWrite === true
      ? findPreviousNonSystemMessageIndex(messages, latestIndex - 1)
      : latestIndex;
  if (cacheControlIndex === undefined) return undefined;

  const message = messages[cacheControlIndex]!;
  messages[cacheControlIndex] = {
    ...message,
    cacheControl: { type: "ephemeral" },
  };
  return cacheControlIndex;
}

/**
 * 从 startIndex 向前查找最近的非 system 消息下标；全部是 system 时返回 undefined。
 * 起点会 clamp 到数组末尾，避免调用方传入越界值。纯函数。
 */
function findPreviousNonSystemMessageIndex(
  messages: readonly ModelInputMessage[],
  startIndex: number,
): number | undefined {
  for (let index = Math.min(startIndex, messages.length - 1); index >= 0; index--) {
    if (messages[index]?.role !== "system") return index;
  }
  return undefined;
}

/**
 * 清除所有非 system 消息上的 cacheControl，system 消息上的 marker 不动。
 * 原因：本函数只负责"最新上下文锚点"，旧 marker 若残留会形成多个断点，
 * 影响 provider 的缓存命中范围。副作用：原地替换数组元素（去掉 cacheControl 字段）。
 */
function clearNonSystemMessageCacheControl(messages: ModelInputMessage[]): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "system" || !message.cacheControl) continue;
    const { cacheControl: _cacheControl, ...messageWithoutCacheControl } = message;
    messages[index] = messageWithoutCacheControl;
  }
}
