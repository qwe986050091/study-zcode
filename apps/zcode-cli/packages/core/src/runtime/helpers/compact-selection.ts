// ============================================================
// compact-selection —— compact 的"切分选择"层(纯函数,无 I/O、无副作用)
// ============================================================
//
// 【职责】
//   给定当前 runtime 条目(activeEntries)与 trigger,决定两件事:
//     1) entriesForSummary:要交给摘要模型的"较早历史"(不含 context prefix);
//     2) preservedEntries:压缩后仍以原文形态留在历史里的"最近轮次"。
//   compact-active 据此调用摘要模型,再拼成
//   [context prefix] → [summary] → [preserved] → [post-compact reminders]。
//
// 【输入口径】
//   - 只认 RuntimeMessageEntry。context prefix(system / context_prefix /
//     skills_listing)由 countContextPrefixMessages 按"连续前缀"识别,
//     一旦前缀中断就不再计入,避免把用户正文误判为可缓存的系统段。
//   - 分组用 groupByAssistantStartedRounds:每遇到新的 assistant 消息开启新组,
//     "一个组 = 一次 assistant 回复 + 它之前的全部输入/工具结果",
//     因此"保留最近 N 组"等价于"保留最近 N 次助手轮次"。
//   - trigger 只影响是否保留最近轮次:Auto / Reactive 保留;
//     Manual / Partial / SessionMemory 全部摘要(见 splitRuntimeEntriesForCompactSelection)。
//
// 【输出/副作用】
//   纯函数。返回的条目一律 cloneRuntimeEntry 做防御性拷贝,
//   调用方可以安全地整体替换 messageHistory,不会与原历史共享可变对象。
//
// 【失败与降级】
//   无法再保留更多轮次、无法解析 token 差额、或剩余历史不足以再压缩时返回 null,
//   由 compact-active 走"沿用旧选择 / 截断重试 / 外层重试"降级。
//
// 【不变量】
//   - 至少留 1 组给摘要(groupsToPreserve <= groups.length - 1),否则没有可摘要内容;
//   - 保留区间落到 durable 侧时必须用 SessionStore 真实消息重新计算
//     (见 compact-preservation.ts),不能把这里基于 runtime 条数的结果直接当消息数。
// ============================================================
import {
  COMPACT_PROMPT_TOO_LONG_RETRY_MARKER,
  CompactTrigger,
  MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
  countContextPrefixMessages,
  estimateMessageTokens,
  modelMessageContentToText,
  traceContextToLogContext,
} from "../deps.js";
import type { TraceContext } from "../deps.js";
import {
  cloneRuntimeMessageEntry,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { groupByAssistantStartedRounds } from "../../compact/rounds.js";
import { buildProviderRequestMessages } from "./provider-request-messages.js";

interface CompactRetryLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/** 一次 compact 切分的结果:谁进摘要、谁保留、保留了几组。 */
export interface CompactEntrySelection {
  /** 摘要请求的输入:context prefix + 待摘要的较早轮次(已 clone)。 */
  entriesForSummary: RuntimeMessageEntry[];
  /** 实际保留的 assistant 轮次数;0 表示全部摘要(manual 等 trigger 的常态)。 */
  groupsPreserved: number;
  /** 保留区间的条目原文(已 clone),按原顺序排在摘要之后。 */
  preservedEntries: RuntimeMessageEntry[];
  /** 切分时正文(body)的总组数,不含 context prefix;供上层判断"还能不能再保留"。 */
  totalGroups: number;
}

/**
 * compact 的常规切分入口。
 *
 * 输入:runtime 条目快照 + 可选的"最少保留组数"(token-gap 重切时由上层抬高)
 *       + trigger(决定默认是否保留最近轮次)。
 * 输出:entriesForSummary / preservedEntries / groupsPreserved / totalGroups。
 * 语义:Auto / Reactive 默认保留最近 1 组;minimumGroupsToPreserve 只能在此基础
 *       上"多保留",且上限为 totalGroups - 1(至少留一组给摘要)。
 *       非保留类 trigger 恒为 0,即使调用方传了 minimumGroupsToPreserve 也不生效。
 * 副作用:无(纯函数,输出全部为防御性拷贝)。
 * 失败:不抛错;历史过短时返回 groupsPreserved=0 的保守结果,
 *       由 hasEnoughRuntimeEntriesToCompact 在调用方决定能否真正发起压缩。
 * 不变量:summaryGroups 与 preservedGroups 是 groups 的连续尾切分,
 *         二者拼接后与原始 body 顺序一致,不会丢失/重排消息。
 */
export function selectCompactEntries(input: {
  entries: readonly RuntimeMessageEntry[];
  minimumGroupsToPreserve?: number;
  trigger: CompactTrigger;
}): CompactEntrySelection {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  const baseGroupsToPreserve = split.shouldPreserveRecent && split.groups.length > 1 ? 1 : 0;
  const requestedGroupsToPreserve = Math.max(
    baseGroupsToPreserve,
    positiveInt(input.minimumGroupsToPreserve) ?? 0,
  );
  const maxGroupsToPreserve = Math.max(0, split.groups.length - 1);
  const groupsToPreserve = split.shouldPreserveRecent
    ? Math.min(requestedGroupsToPreserve, maxGroupsToPreserve)
    : 0;
  const summaryGroups =
    groupsToPreserve > 0
      ? split.groups.slice(0, split.groups.length - groupsToPreserve)
      : split.groups;
  const preservedGroups = groupsToPreserve > 0 ? split.groups.slice(-groupsToPreserve) : [];

  return {
    entriesForSummary: [...split.prefixEntries, ...summaryGroups.flat()].map(cloneRuntimeEntry),
    groupsPreserved: groupsToPreserve,
    preservedEntries: preservedGroups.flat().map(cloneRuntimeEntry),
    totalGroups: split.groups.length,
  };
}

/**
 * Provider 已经报过 prompt-too-long 之后的重切分。
 *
 * 触发时机:compact-active 的摘要请求被 provider 判定超窗(实际 token > 上限),
 * 不再增加截断,而是"把更多最近轮次移出摘要请求"来缩小输入。
 * 输入:原始条目 + 触发本次重切的 cause(用于解析 token 差额) + 当前已保留组数。
 * 输出:新的切分结果;或 null 表示"无法再改善"(调用方保持旧选择)。
 * 语义:groupsToMove 由 countRecentGroupsToPreserveAfterPromptTooLong 解析出的
 *       token 差额决定;当差额无法解析时保守地至少多保留 1 组。
 * 失败/降级:以下情况一律返回 null,避免无进展的重试:
 *   trigger 本身不保留轮次、组数不足 2、已到保留上限、移动后没有净增量、
 *   或新选择已不足以再压缩。
 * 副作用:无(只读输入并返回 clone)。
 */
export function selectCompactEntriesAfterPromptTooLong(input: {
  entries: readonly RuntimeMessageEntry[];
  promptTooLongCause: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
  currentGroupsPreserved: number;
}): CompactEntrySelection | null {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  if (!split.shouldPreserveRecent || split.groups.length < 2) {
    return null;
  }

  const maxGroupsToPreserve = split.groups.length - 1;
  if (input.currentGroupsPreserved >= maxGroupsToPreserve) {
    return null;
  }

  const summarizedGroupCount = split.groups.length - input.currentGroupsPreserved;
  const groupsForSummary = split.groups.slice(0, summarizedGroupCount);
  if (groupsForSummary.length < 2) {
    return null;
  }

  const groupsToMove = countRecentGroupsToPreserveAfterPromptTooLong(
    groupsForSummary,
    input.promptTooLongCause,
    { useMidConversationSystem: input.useMidConversationSystem },
  );
  const nextGroupsPreserved = Math.min(
    maxGroupsToPreserve,
    input.currentGroupsPreserved + groupsToMove,
  );
  if (nextGroupsPreserved <= input.currentGroupsPreserved) {
    return null;
  }

  const nextSelection = selectCompactEntries({
    entries: input.entries,
    minimumGroupsToPreserve: nextGroupsPreserved,
    trigger: input.trigger,
  });
  return hasEnoughRuntimeEntriesToCompact(nextSelection.entriesForSummary) ? nextSelection : null;
}

/**
 * "首次摘要请求就超窗"时的切分(initial prompt-too-long)。
 *
 * 与 AfterPromptTooLong 的区别:此时还一次都没有真正发起摘要,
 * 因此不必基于"当前已保留组数"增量推进,而是直接按 token 差额一次性补齐。
 * 输入/输出同前;返回 null 表示无法采用该策略(组数 <= 3、无差额、差额已被
 * 最近一组覆盖、或切分后不足以再压缩)。
 * 关键口径:alreadyPreservedTokens 取自 groupTokenEstimates.at(-1),
 *   即"默认就会保留的那一组"已能提供的 token;只有剩余差额才需要额外保留,
 *   避免重复计算导致保留过多、摘要内容反而不足。
 * 副作用:无。
 */
export function selectCompactEntriesForInitialPromptTooLong(input: {
  entries: readonly RuntimeMessageEntry[];
  promptTooLongCause: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}): CompactEntrySelection | null {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  if (!split.shouldPreserveRecent || split.groups.length <= 3) {
    return null;
  }

  const tokenGap = getPromptTooLongTokenGap(input.promptTooLongCause);
  if (tokenGap === undefined) {
    return null;
  }

  const groupTokenEstimates = estimateCompactGroupTokens(split.groups, {
    useMidConversationSystem: input.useMidConversationSystem,
  });
  const alreadyPreservedTokens = groupTokenEstimates.at(-1) ?? 0;
  const remainingTokenGap = tokenGap - alreadyPreservedTokens;
  if (remainingTokenGap <= 0) {
    return null;
  }

  const additionalGroupsToPreserve = countRecentGroupsToCoverTokenGap(
    groupTokenEstimates,
    split.groups.length - 1,
    remainingTokenGap,
  );
  const nextSelection = selectCompactEntries({
    entries: input.entries,
    minimumGroupsToPreserve: 1 + additionalGroupsToPreserve,
    trigger: input.trigger,
  });
  return hasEnoughRuntimeEntriesToCompact(nextSelection.entriesForSummary) ? nextSelection : null;
}

/**
 * 只取"可进摘要"的条目:过滤掉 context prefix(system / context_prefix /
 * skills_listing / literal <system-reminder> 开头的 user 消息)后 clone。
 * 供 compact-active 计算 summarizedMessageCount 和摘要请求正文使用。
 */
export function getRuntimeEntriesToSummarize(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[] {
  return entries.filter((entry) => !isRuntimeContextPrefixEntry(entry)).map(cloneRuntimeEntry);
}

/**
 * 判断"压缩是否还有意义"的最低门槛:可摘要条目至少 2 个 assistant 轮次,
 * 且其中必须含 assistant 消息。只有 user/tool 而没有助手回复时,
 * 摘要模型拿不到可归纳的结论,压缩只会白花一次请求。
 * 注意:这里只看 entriesForSummary(已剔除 context prefix)。
 */
export function hasEnoughRuntimeEntriesToCompact(entries: readonly RuntimeMessageEntry[]): boolean {
  const entriesToSummarize = getRuntimeEntriesToSummarize(entries);
  return (
    groupRuntimeEntriesByCompactRound(entriesToSummarize).length >= 2 &&
    entriesToSummarize.some((entry) => runtimeEntryRole(entry) === "assistant")
  );
}

/**
 * 用真实 provider 渲染口径估算一组条目的 token。
 *
 * 先经 buildProviderRequestMessages 投影(关闭 cacheControl,因为纯估算不需要
 * cache 断点),再用 estimateMessageTokens 计数。这样得出的数值与真正发给
 * provider 的结构一致,避免直接用 runtime 条数/字符数造成偏差。
 * useMidConversationSystem 决定 system reminder 是按"中间 system 消息"
 * 还是按 user 文本渲染,会影响估算结果,必须与真实请求保持一致。
 */
export function estimateRuntimeEntryTokens(
  entries: readonly RuntimeMessageEntry[],
  options: { useMidConversationSystem?: boolean } = {},
): number {
  const providerMessages = buildProviderRequestMessages({
    entries,
    applyCacheControl: false,
    useMidConversationSystem: options.useMidConversationSystem,
  }).messages;
  return estimateMessageTokens(providerMessages);
}

/**
 * prompt-too-long 的内层重试:从最老的轮次开始丢弃一部分,直到覆盖 token 差额。
 *
 * 输入:attempt(已失败的次数)、cause(含 "N tokens > M" 的差额)、
 *       待摘要条目、可选 logger 与 trace。
 * 输出:新的条目列表(仍保留 context prefix);null 表示放弃这次重试。
 * 语义:这是"缩小摘要输入"的最后手段,只在 manual / partial 等允许截断的
 *       trigger 上使用(Auto / Reactive 不允许静默丢历史,见 compact-active)。
 * 副作用:仅在确实发生重试时 logger.warn 一条事件(含 attempt / 丢弃条数)。
 * 失败:达到 MAX_COMPACT_PROMPT_TOO_LONG_RETRIES、无法截断、或剩余不足时返回 null,
 *       由调用方转成 CompactFailed。
 * 不变量:context prefix 永远保留;若截断后首条是 assistant,补一条
 *         COMPACT_PROMPT_TOO_LONG_RETRY_MARKER 的 user 占位,维持 role 交替合法。
 */
export function truncateCompactSummaryRequestEntriesAfterPromptTooLong(options: {
  attempt: number;
  cause: unknown;
  entriesForSummary: readonly RuntimeMessageEntry[];
  logger?: CompactRetryLogger;
  traceContext: TraceContext;
  useMidConversationSystem?: boolean;
}): RuntimeMessageEntry[] | null {
  if (options.attempt >= MAX_COMPACT_PROMPT_TOO_LONG_RETRIES) {
    options.logger?.warn("Compact summary prompt was too long; retry limit reached", {
      ...traceContextToLogContext(options.traceContext),
      attempt: options.attempt,
      event: "compact.prompt_too_long.retry_limit",
      maxAttempts: MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
      module: "core.runtime",
      remainingMessages: options.entriesForSummary.length,
    });
    return null;
  }

  const truncated = truncateRuntimeEntriesForCompactRetry(
    options.entriesForSummary,
    options.cause,
    { useMidConversationSystem: options.useMidConversationSystem },
  );
  if (!truncated) {
    return null;
  }

  options.logger?.warn("Compact summary prompt was too long; retrying with older rounds dropped", {
    ...traceContextToLogContext(options.traceContext),
    attempt: options.attempt + 1,
    droppedMessages: options.entriesForSummary.length - truncated.length,
    event: "compact.prompt_too_long.retry",
    maxAttempts: MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
    module: "core.runtime",
    remainingMessages: truncated.length,
  });

  return truncated;
}

/**
 * 把条目拆成"连续 context prefix" + "按 assistant 轮次分组的正文"。
 * 前缀必须连续:countContextPrefixMessages 遇首个非前缀条目即停,
 * 因此后面零散注入的 reminder 会被归入正文,随摘要一起被压缩。
 * shouldPreserveRecent 只由 trigger 决定(Auto / Reactive 才保留最近轮次)。
 */
function splitRuntimeEntriesForCompactSelection(
  inputEntries: readonly RuntimeMessageEntry[],
  trigger: CompactTrigger,
): {
  groups: RuntimeMessageEntry[][];
  prefixEntries: RuntimeMessageEntry[];
  shouldPreserveRecent: boolean;
} {
  const entries = inputEntries.map(cloneRuntimeEntry);
  const prefixCount = countContextPrefixMessages(entries);
  const prefixEntries = entries.slice(0, prefixCount);
  const bodyEntries = entries.slice(prefixCount);

  return {
    groups: groupRuntimeEntriesByCompactRound(bodyEntries),
    prefixEntries,
    shouldPreserveRecent: trigger === CompactTrigger.Auto || trigger === CompactTrigger.Reactive,
  };
}

/**
 * prompt-too-long 后需要额外保留多少个最近组:把差额当作"要不要多撇下一组"的
 * 预算,从最新的组往回累加 token,直到覆盖差额。
 * 无法解析差额时返回 1:宁可多保留一组(摘要输入更小),也不要原地重试。
 */
function countRecentGroupsToPreserveAfterPromptTooLong(
  groupsForSummary: readonly RuntimeMessageEntry[][],
  promptTooLongCause: unknown,
  options: { useMidConversationSystem?: boolean } = {},
): number {
  const tokenGap = getPromptTooLongTokenGap(promptTooLongCause);
  if (tokenGap === undefined) {
    return 1;
  }

  const groupTokenEstimates = estimateCompactGroupTokens(groupsForSummary, {
    useMidConversationSystem: options.useMidConversationSystem,
  });
  return countRecentGroupsToCoverTokenGap(groupTokenEstimates, groupsForSummary.length, tokenGap);
}

/**
 * 从最新组向前累加 token,返回覆盖 tokenGap 所需的最少组数(至少 1)。
 *
 * 为什么封顶到 groupCount/2:如果差额大到几乎要保留全部组,
 * 摘要请求就没有内容可归纳了;退回到"保留一半"是保证
 * "既有足够原文、又有足够可摘要历史"的折中。
 */
function countRecentGroupsToCoverTokenGap(
  groupTokenEstimates: readonly number[],
  groupCount: number,
  tokenGap: number,
): number {
  if (tokenGap <= 0 || groupCount <= 0) {
    return 0;
  }

  let tokensCovered = 0;
  let groupsCovered = 0;
  for (let index = groupCount - 1; index >= 0; index -= 1) {
    tokensCovered += groupTokenEstimates[index] ?? 0;
    groupsCovered += 1;
    if (tokensCovered >= tokenGap) break;
  }

  if (groupsCovered >= groupCount - 1) {
    // 覆盖差额所需的组数几乎等于全部:不能把摘要输入清空,折中保留一半。
    return Math.max(1, Math.floor(groupCount / 2));
  }
  return Math.max(1, groupsCovered);
}

function estimateCompactGroupTokens(
  groups: readonly RuntimeMessageEntry[][],
  options: { useMidConversationSystem?: boolean } = {},
): number[] {
  return groups.map((group) =>
    estimateRuntimeEntryTokens(group, {
      useMidConversationSystem: options.useMidConversationSystem,
    }),
  );
}

/**
 * 截断版切分:保留 context prefix,丢弃最老的若干轮次,必要时补 retry marker。
 *
 * 输入:已投影到 provider 的待摘要条目、cause(用于取 token 差额)、
 *       useMidConversationSystem(估算口径必须与真实请求一致)。
 * 输出:截断后的条目;null 表示无法再截断(组数 < 2 或丢弃后为空)。
 * 语义:能解析差额时按差额丢;解析不到时按 20% 丢(经验比例),
 *       确保每次重试都确实减少了输入,避免 provider 同为超窗而无限重试。
 * 不变量:绝不丢 context prefix;最多丢到只剩 1 组(groups.length - 1)。
 */
function truncateRuntimeEntriesForCompactRetry(
  entries: readonly RuntimeMessageEntry[],
  promptTooLongCause: unknown,
  options: { useMidConversationSystem?: boolean } = {},
): RuntimeMessageEntry[] | null {
  const prefix: RuntimeMessageEntry[] = [];
  let index = 0;
  while (index < entries.length && isRuntimeContextPrefixEntry(entries[index]!)) {
    prefix.push(cloneRuntimeEntry(entries[index]!));
    index += 1;
  }

  let candidates = entries.slice(index);
  if (candidates[0] && isCompactPromptTooLongRetryMarker(candidates[0])) {
    candidates = candidates.slice(1);
  }

  const groups = groupRuntimeEntriesByCompactRound(candidates);
  if (groups.length < 2) return null;

  const tokenGap = getPromptTooLongTokenGap(promptTooLongCause);
  let dropCount = 0;
  if (tokenGap !== undefined) {
    let droppedTokens = 0;
    for (const group of groups) {
      droppedTokens += estimateRuntimeEntryTokens(group, {
        useMidConversationSystem: options.useMidConversationSystem,
      });
      dropCount += 1;
      if (droppedTokens >= tokenGap) break;
    }
  } else {
    // 无法从错误文本解析差额:按 20% 固定比例丢最老轮次,保证"每次重试都更小"。
    dropCount = Math.max(1, Math.floor(groups.length * 0.2));
  }

  dropCount = Math.min(dropCount, groups.length - 1);
  if (dropCount < 1) return null;

  const sliced = groups.slice(dropCount).flat().map(cloneRuntimeEntry);
  if (sliced.length === 0) return null;

  const needsMarker = sliced[0] && runtimeEntryRole(sliced[0]) === "assistant";
  // 丢掉开头后若以 assistant 起头,补一条 user 占位维持 user/assistant 交替,
  // 否则部分 provider 会直接拒绝该请求。
  return [
    ...prefix,
    ...(needsMarker
      ? [
          {
            message: {
              role: "user" as const,
              content: COMPACT_PROMPT_TOO_LONG_RETRY_MARKER,
            },
          },
        ]
      : []),
    ...sliced,
  ];
}

/**
 * 判断一条条目是否属于"可缓存、不参与摘要"的 context prefix。
 * 判定优先级:attachment/消息 metadata 的 source 优先;无 metadata 时,
 * 只有 system role 或文本以 <system-reminder> 开头(trimStart 后)才算。
 * 为什么不用纯文本前缀做主判据:用户正文可能字面包含该标签,
 * metadata 才是 runtime 注入的权威身份。
 */
function isRuntimeContextPrefixEntry(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) {
    return entry.metadata.source === "context_prefix" || entry.metadata.source === "skills_listing";
  }
  if (entry.message.role === "system") return true;
  if (entry.message.role !== "user") return false;
  if (entry.metadata) {
    return entry.metadata.source === "context_prefix" || entry.metadata.source === "skills_listing";
  }
  return modelMessageContentToText(entry.message.content)
    .trimStart()
    .startsWith("<system-reminder>");
}

function isCompactPromptTooLongRetryMarker(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return false;
  return (
    entry.message.role === "user" &&
    modelMessageContentToText(entry.message.content) === COMPACT_PROMPT_TOO_LONG_RETRY_MARKER
  );
}

/**
 * 按 compact 的轮次口径分组:attachment 视为 user(它总附着在用户输入前后),
 * 其余按真实 role 分组。
 */
function groupRuntimeEntriesByCompactRound(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[][] {
  return groupByAssistantStartedRounds(entries, runtimeEntryRole);
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/**
 * 从任意错误对象里找 "N tokens > M" 的 token 差额。
 * provider SDK / HTTP body 的错误结构不统一,这里按 message → errorDetails /
 * details / body → cause / lastError / error 逐层下钻(最多 6 层),
 * 并用 WeakSet 防环。找不到就返回 undefined,由调用方选择保守降级策略。
 */
function getPromptTooLongTokenGap(cause: unknown): number | undefined {
  let current: unknown = cause;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= 6; depth += 1) {
    if (typeof current === "string") {
      const gap = parsePromptTooLongTokenGap(current);
      if (gap !== undefined) return gap;
      return undefined;
    }
    if (current === undefined || current === null || typeof current !== "object") {
      return undefined;
    }
    if (seen.has(current)) return undefined;
    seen.add(current);

    const record = current as Record<string, unknown>;
    for (const key of ["message", "errorDetails", "details", "body"]) {
      const value = record[key];
      if (typeof value === "string") {
        const gap = parsePromptTooLongTokenGap(value);
        if (gap !== undefined) return gap;
      }
    }
    current = record.cause ?? record.lastError ?? record.error;
  }

  return undefined;
}

/**
 * 解析 "actual tokens > limit" 文本,返回向上取整的差额;非法/非溢出返回 undefined。
 * 只接受 actual > limit 的情况,避免把 provider 的其它数字误当成差额。
 */
function parsePromptTooLongTokenGap(message: string): number | undefined {
  const match = message.match(/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i);
  if (!match) return undefined;

  const actual = Number(match[1]?.replace(/,/g, ""));
  const limit = Number(match[2]?.replace(/,/g, ""));
  if (!Number.isFinite(actual) || !Number.isFinite(limit) || actual <= limit) {
    return undefined;
  }
  return Math.ceil(actual - limit);
}

function cloneRuntimeEntry(entry: RuntimeMessageEntry): RuntimeMessageEntry {
  return cloneRuntimeMessageEntry(entry);
}

function runtimeEntryRole(entry: RuntimeMessageEntry): "system" | "user" | "assistant" | "tool" {
  if (isRuntimeAttachmentEntry(entry)) return "user";
  return entry.message.role;
}
