import type {
  ModelInputMessage,
  RuntimeMessageEntry,
  RuntimeMessageMessageEntry,
} from "../../agent/message-history.js";
import {
  isRuntimeAttachmentEntry,
  isKnownSystemReminderSource,
} from "../../agent/message-history.js";
import {
  isMidConversationSystemSource,
  sanitizeSystemReminderBody,
  wrapSystemReminder,
} from "../../system-reminder/source.js";
import { isPresentedInput, type ProviderEntryOrigins } from "./provider-entry-origins.js";

/**
 * 等待落点的 mid-conversation system 条目。
 *
 * 字段口径：
 * - entry：canonical attachment 条目，保留以便降级时原样放回；
 * - text：已展开的系统提醒正文（不含 user/system 包装），合并时直接拼接。
 */
interface PendingMidSystemEntry {
  entry: RuntimeMessageEntry;
  text: string;
}

/**
 * MCS 投影附带的信息。
 *
 * fallbackBody：降级为 legacy user system-reminder 时使用的正文；多条提醒合并
 * 到同一个 system 条目后，这里也要同步追加，否则降级只保留第一条内容。
 */
interface MidSystemProjection {
  fallbackBody: string;
}

/**
 * 已投影成 role=system 的 MCS 条目。
 *
 * 它不继承 RuntimeMessageMessageEntry 的 metadata（合成条目没有 canonical 来源），
 * 来源关系改由 origins 记录；midSystemProjection 是该条目的可降级正文。
 */
interface ProjectedMidSystemMessageEntry extends RuntimeMessageMessageEntry {
  midSystemProjection: MidSystemProjection;
}

/** 投影后的条目联合类型：普通条目或 MCS system 条目。 */
export type ProjectedRuntimeMessageEntry = RuntimeMessageEntry | ProjectedMidSystemMessageEntry;

/** MCS 投影结果：顺序与输入一致，但部分条目可能被合并或降级为 legacy user 消息。 */
interface MidSystemProjectionResult {
  entries: ProjectedRuntimeMessageEntry[];
}

/**
 * 把 mid-conversation system 来源的系统提醒投影到对话中间（role=system）。
 *
 * 背景：canonical history 里系统提醒以 attachment 条目存在，provider 请求中默认渲染为
 * 包了 user 包装的文本；当模型支持 MCS 时，可以在合法的 provider 边界把它渲染成
 * 真正的 system 消息，减少 user 噪声、提升缓存命中。
 *
 * 处理流程：
 * 1. 遇到 MCS 来源的 attachment 先进入 pending 缓冲，不立即落位；
 * 2. 在因果边界（presented input、其后紧跟 user）前强制 flush，保证中途输入不被越过；
 * 3. 普通边界（assistant/system）前也 flush；
 * 4. flush 时优先合并到上一条 MCS system，其次锚定在 tool/user 之后新建 system，
 *    无法锚定时原样放回（交由 validate 降级）；
 * 5. 最后 validateMidConversationSystemPositions 校验 provider 合法位置。
 *
 * 输入输出：entries 顺序不因投影改变；输出长度可能因合并而缩短。
 * 副作用：写入 origins（合成 system/降级条目 → 原始 attachment）；不落盘。
 * 失败与降级：非法位置不抛错，改为 legacy user system-reminder（见 validate）。
 */
export function projectMidConversationSystemEntries(
  entries: readonly RuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): MidSystemProjectionResult {
  const projected: ProjectedRuntimeMessageEntry[] = [];
  const pending: PendingMidSystemEntry[] = [];

  const flushPending = (): void => {
    if (pending.length === 0) return;
    const pendingItems = pending.splice(0);
    const body = pendingItems.map((item) => item.text).join("\n\n");
    const previous = projected.at(-1);

    // 相邻 MCS 合并成一个 system：多个连续 system 在部分 provider 上语义不同，合并最稳。
    if (previous && isProjectedMidSystemEntry(previous)) {
      origins.set(previous, [previous, ...pendingItems.map((item) => item.entry)]);
      previous.message = {
        ...previous.message,
        content: `${previous.message.content}\n\n${body}`,
      };
      previous.midSystemProjection.fallbackBody = `${previous.midSystemProjection.fallbackBody}\n\n${body}`;
      return;
    }

    // 只有上一条位于合法锚点（user/tool）时才新建 system，否则放回原条目等更靠后的位置。
    if (previous && canAnchorMidConversationSystemAfter(previous)) {
      const systemEntry: ProjectedMidSystemMessageEntry = {
        message: {
          role: "system",
          content: body,
        },
        midSystemProjection: { fallbackBody: body },
      };
      origins.set(
        systemEntry,
        pendingItems.map((item) => item.entry),
      );
      projected.push(systemEntry);
      return;
    }

    // 找不到合法落点时保留原 attachment 条目，后续 validate 会把它降级为 legacy user reminder。
    projected.push(...pendingItems.map((item) => item.entry));
  };

  for (const entry of entries) {
    // 中途输入是因果边界：不能被普通 reminder 越过，也不能越过后来的 user。
    const hasIncoming = pending.some((item) => isPresentedInput(item.entry));
    const nextIsUser = !isRuntimeAttachmentEntry(entry) && entry.message.role === "user";
    // 中途输入是不可越过的因果边界：若 pending 里已有中途输入，则遇到下一个 user 前必须落位。
    if (pending.length > 0 && (isPresentedInput(entry) || (hasIncoming && nextIsUser)))
      flushPending();
    const projectedText = midConversationSystemText(entry);
    if (projectedText !== undefined) {
      pending.push({ entry, text: projectedText });
      continue;
    }

    if (pending.length > 0 && shouldFlushMidConversationSystemBefore(entry)) {
      flushPending();
    }

    projected.push(entry);
  }

  flushPending();

  return { entries: validateMidConversationSystemPositions(projected, origins) };
}

/**
 * 读取条目若为 MCS 来源则返回其正文，否则 undefined。
 *
 * 仅 attachment 条目参与：普通 user/system 消息即使 source 相同也不搬迁，
 * 因为 MCS 只针对系统提醒的渲染形态。正文原样返回（尚未做 user 包装）。
 * 纯函数，无副作用。
 */
function midConversationSystemText(entry: RuntimeMessageEntry): string | undefined {
  if (isRuntimeAttachmentEntry(entry)) {
    const source = entry.metadata.source;
    if (!isKnownSystemReminderSource(source)) return undefined;
    if (!isMidConversationSystemSource(source)) return undefined;
    return entry.content;
  }
  return undefined;
}

/**
 * 判断当前条目之前是否必须把 pending MCS 落位。
 *
 * assistant/system 是 provider 的合法边界：system 不能夹在 tool call 与 tool result
 * 之间；attachment 条目不算边界（它本身也是 user 文本，先放行由后续规则处理）。
 * 纯函数，无副作用。
 */
function shouldFlushMidConversationSystemBefore(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return false;
  // pending system reminder 需要等到 assistant 或系统边界再落点，
  // 避免插入同一组 tool results 中间导致 provider-visible 顺序非法。
  return entry.message.role === "assistant" || entry.message.role === "system";
}

/**
 * 判断 MCS system 能否紧跟在某条目之后。
 *
 * provider 的合法序列要求 system 出现在 user/tool 之后、assistant 之前；model-only user
 * （如目标续跑）在 provider 侧仍是 user，因此也可锚定，不能因内部 metadata 被误降级。
 * 纯函数，无副作用。
 */
function canAnchorMidConversationSystemAfter(entry: ProjectedRuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return false;
  const message = entry.message;
  // mid-conversation system 的合法 anchor 对齐 provider-visible role，
  // model-only user（如目标续跑）仍然是 user 消息，不能因内部 source metadata 被误降级。
  if (message.role === "tool") return true;
  return message.role === "user";
}

/**
 * 校验 MCS system 的落点，非法位置降级为 legacy user system-reminder。
 *
 * 合法条件：前一条能锚定（user/tool），且下一条为空/MCS/assistant——即 system
 * 不夹在 tool result 段中间，也不出现在 assistant 之后。
 * 降级时必须自行 sanitize + wrap：MCS 正文未经过 user 包装，producer 不负责转义。
 * origins 记录 fallback → 原 MCS 条目，保持来源可回溯。不抛错，纯内存重写。
 */
function validateMidConversationSystemPositions(
  entries: readonly ProjectedRuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): ProjectedRuntimeMessageEntry[] {
  const projected: ProjectedRuntimeMessageEntry[] = [];

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!isProjectedMidSystemEntry(entry)) {
      projected.push(entry);
      continue;
    }

    const previous = projected.at(-1);
    const next = entries[index + 1];
    if (previous && canKeepMidConversationSystemBetween(previous, next)) {
      projected.push(entry);
      continue;
    }

    // mid-conversation system 只有在 provider 合法边界才保留；
    // 其他位置降级为旧的 user system-reminder，避免在请求体中生成非法 role 顺序。
    const fallback: RuntimeMessageEntry = {
      message: {
        role: "user",
        // MCS 正文未经过 user 包装，降级必须自行转义，不能假设 producer 已处理。
        content: wrapSystemReminder(
          sanitizeSystemReminderBody(entry.midSystemProjection.fallbackBody),
        ),
      },
      metadata: { source: "legacy_synthetic" },
    };
    origins.set(fallback, [entry]);
    projected.push(fallback);
  }

  return projected;
}

/**
 * 判断 MCS system 能否保留在 previous 与 next 之间。
 *
 * previous 必须可锚定；next 缺失（末尾）或仍是 MCS 可保留；attachment 不允许
 * （说明它夹在提醒之间）；只有 assistant 可作为 MCS 之后的边界。纯函数。
 */
function canKeepMidConversationSystemBetween(
  previous: ProjectedRuntimeMessageEntry,
  next: ProjectedRuntimeMessageEntry | undefined,
): boolean {
  if (!canAnchorMidConversationSystemAfter(previous)) return false;
  if (!next) return true;
  if (isProjectedMidSystemEntry(next)) return true;
  if (isRuntimeAttachmentEntry(next)) return false;
  return next.message.role === "assistant";
}

/** 类型守卫：通过 midSystemProjection 字段区分合成 system 条目。纯函数。 */
function isProjectedMidSystemEntry(
  entry: ProjectedRuntimeMessageEntry | undefined,
): entry is ProjectedMidSystemMessageEntry {
  return Boolean(entry && "midSystemProjection" in entry && entry.midSystemProjection);
}

/**
 * 把 legacy/fallback system-reminder 移到连续 tool result 段之后。
 *
 * 原因：Anthropic 序列化只会合并相邻 user role，不会把 tool_result 自动排回 text 之前；
 * 若 legacy reminder 夹在一组 tool results 中间，请求顺序非法。
 * 处理：遇到需要搬迁的 reminder 先缓存，后续仍是 tool result 就继续缓存；遇到非 tool
 * 条目则先 flush 再放当前条目。末尾 flush 缓存。
 * 输入输出：不修改原条目，只重排；tool 段内的相对顺序保持不变。
 */
export function moveLegacySystemRemindersAfterToolResultRun(
  entries: readonly ProjectedRuntimeMessageEntry[],
): ProjectedRuntimeMessageEntry[] {
  // legacy/fallback system-reminder 是普通 user text；
  // 若夹在同一组 tool results 中间，Anthropic 序列化只会合并 role，不会自动把 tool_result 排回 text 前。
  const projected: ProjectedRuntimeMessageEntry[] = [];
  const pendingLegacyReminders: ProjectedRuntimeMessageEntry[] = [];

  const flushPendingLegacyReminders = (): void => {
    if (pendingLegacyReminders.length === 0) return;
    projected.push(...pendingLegacyReminders.splice(0));
  };

  for (const entry of entries) {
    if (
      isLegacySystemReminderEntry(entry) &&
      (pendingLegacyReminders.length > 0 || isToolResultEntry(projected.at(-1)))
    ) {
      pendingLegacyReminders.push(entry);
      continue;
    }

    if (pendingLegacyReminders.length > 0) {
      if (isToolResultEntry(entry)) {
        projected.push(entry);
        continue;
      }
      flushPendingLegacyReminders();
    }

    projected.push(entry);
  }

  flushPendingLegacyReminders();
  return projected;
}

/**
 * 判断条目是否属于需要搬迁的 legacy reminder。
 *
 * attachment 条目在 provider 渲染后也是 user 文本，同样可能夹在 tool result 段中间；
 * 另一类是显式 metadata.source=legacy_synthetic 的 user 消息（MCS 降级产物）。
 * 纯函数，无副作用。
 */
function isLegacySystemReminderEntry(entry: ProjectedRuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return true;
  return entry.message.role === "user" && entry.metadata?.source === "legacy_synthetic";
}

/**
 * 判断条目是否为工具结果段的一员：role=tool，或工具结果型 user 消息。
 * attachment 条目虽然也是 user 文本，但不是工具结果，不参与连续段判定。纯函数。
 */
function isToolResultEntry(entry: ProjectedRuntimeMessageEntry | undefined): boolean {
  if (!entry || isRuntimeAttachmentEntry(entry)) return false;
  return entry.message.role === "tool" || isToolResultUserMessage(entry.message);
}

/**
 * 判断 user 消息是否是工具结果：带 toolCallId 或 toolName 即为工具结果形态。
 * 这是 provider 渲染时区分"真实用户"与工具回包的统一口径，也被 MCS/上浮逻辑复用。
 * 纯函数，无副作用。
 */
export function isToolResultUserMessage(message: ModelInputMessage): boolean {
  return message.role === "user" && Boolean(message.toolCallId || message.toolName);
}
