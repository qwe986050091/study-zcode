// ============================================================
// Session History Hydrator —— 职责边界
// 入口一：hydrateMessageHistoryFromSession —— 冷恢复时把持久化 messages 重放成 provider history。
// 入口二：activeSessionMessages —— 只负责挑出当前有效分支与当前 compact 段的消息切片。
// 输入：MessageWithParts；message.info 负责角色、来源、usage，parts 负责正文、推理、工具状态。
// 输出：RuntimeMessageEntry、assistant 消息、tool result 三件套，全部写入调用方传入的 history。
// 不做：不调用 provider、不执行工具、不写 session 存储、不改 message.info、不重新生成 id。
// 去重键：part.id，同 id 后写覆盖先写；消息顺序完全沿用有效切片的数组顺序。
// 裁剪顺序：先按 branch 截枝，再从后往前找 compact boundary，最后裁掉 compact 之前那段。
// 补齐顺序：tool 结果按结构化内容、媒体投影、纯文本摘要逐级回退，缺哪级就往下走。
// ============================================================
// INV 不变量表（19 条；每条都对应一次真实冷恢复差异或一条明确的线上故障面）
// INV-01 断言：同一 part.id 只进入 provider history 一次，后出现者覆盖先出现者 —— 守住它的位置：去重阶段的写入顺序 —— 改错故障：冷恢复出现重复正文与重复 tool result，provider 报重复调用标识。
// INV-02 断言：bot_topic_context 的 user 消息与其 synthetic text part 在恢复期整体跳过 —— 守住它的位置：循环开头的来源判断与 parts 过滤 —— 改错故障：旧话题背景重新进入上下文，模型回退到上一轮话题。
// INV-03 断言：shared_context 且状态不是 attached 的用户消息不得进入 provider history —— 守住它的位置：user 分支的提前退出 —— 改错故障：用户尚未发送就把交接候选注入，模型看到本不该出现的上下文。
// INV-04 断言：已持久化为裸文本的 synthetic system reminder 必须在恢复期包回提醒外层 —— 守住它的位置：整条 attachment 升级分支 —— 改错故障：会话中途的系统投影丢失来源，提醒降级成用户正文。
// INV-05 断言：只有可见 text part 恰好一个时才按整条 attachment 恢复 —— 守住它的位置：可见部分数量不等于一就早退 —— 改错故障：混合消息被整条吞成提醒，真实用户正文丢失。
// INV-06 断言：带合法持久化 token 基线的空 assistant 必须保留 —— 守住它的位置：正文、推理、工具三重判空之后的基线判断 —— 改错故障：重启前后上下文估算基准漂移，触发本不该发生的压缩。
// INV-07 断言：completed 工具内容优先结构化内容，其次完整布局投影的媒体，最后才是输出摘要 —— 守住它的位置：内容选择的逐级回退 —— 改错故障：读文件与远程工具产生的媒体在冷恢复后丢失，模型重复读取。
// INV-08 断言：附件存在但布局元数据不完整时必须回退到旧摘要 —— 守住它的位置：投影只在附件块非空时尝试 —— 改错故障：恢复出半截媒体内容，工具结果结构非法。
// INV-09 断言：error 工具优先使用持久化的结构化字符串，缺失才用界面错误文案 —— 守住它的位置：按类型判断而非按真假判断 —— 改错故障：空字符串被界面文案覆盖，模型看到人话而不是真实错误。
// INV-10 断言：非 completed 且非 error 的工具部分一律记为中断，并占满调用标识 —— 守住它的位置：工具循环末尾的兜底写入 —— 改错故障：调用没有配对结果，provider 直接拒绝整段历史。
// INV-11 断言：工具名必须按持久化字段的存在性恢复，空字符串也是合法值 —— 守住它的位置：显式判空而非真假判断 —— 改错故障：空名被通用名覆盖，调用与结果名字不匹配。
// INV-12 断言：有 branch cut 时先按分支选枝，再取最后一个 compact boundary —— 守住它的位置：选枝与裁剪的两个分支 —— 改错故障：压缩前保留的前缀永远恢复不出来。
// INV-13 断言：没有 branch cut 的旧数据必须先压缩再选枝 —— 守住它的位置：legacy 分支的先行压缩 —— 改错故障：历史非法的保留标识被当成新式分支，冷恢复结果突变。
// INV-14 断言：rewind 保留集合全部落在 compact 之前时直接返回压缩结果 —— 守住它的位置：压缩后标识集合的交集判断 —— 改错故障：回滚目标被压缩段吞掉，回滚后消息序列错乱。
// INV-15 断言：展示元数据只叠加到非附件条目，且不覆盖附件类型 —— 守住它的位置：映射分支的条目类型判断 —— 改错故障：文本附件类型被改写，附件从 provider 侧消失。
// INV-16 断言：compact 边界只写到首条条目，且持久化元数据覆盖默认值 —— 守住它的位置：首条条目的展开顺序 —— 改错故障：发现信息被写到错误条目或被默认值冲掉。
// INV-17 断言：代理列表增量必须通过 schema 校验后才进入元数据 —— 守住它的位置：增量解析的安全校验 —— 改错故障：脏增量让整条恢复抛错或写出结构非法的条目。
// INV-18 断言：任务状态与子代理通知只在恢复期包外层，不写回 session 原始记录 —— 守住它的位置：文本投影的包裹分支 —— 改错故障：界面原始记录被污染，重复恢复出现嵌套提醒。
// INV-19 断言：模型调用包装体校验失败即视为缺失，不做宽松修补 —— 守住它的位置：包装体解析的成功分支 —— 改错故障：半残包装体进入请求，provider 拒绝整个调用。
// ============================================================
import { ModelCallWrapperSchema } from "@zcode/contracts";
import {
  hydrateToolSearchContent,
  hydrateCompactDiscovery,
  hydrateToolSearchAnnouncement,
} from "./tool-search-hydration.js";
import { parseAgentListingDelta } from "./agent-listing-metadata.js";
import { runtimeInputMetadata } from "./runtime-input-presentation.js";
// ============================================================
// Session History Hydration - rebuild provider-visible context
// ============================================================

import { modelMessageContentToText, selectActiveConversationBranch } from "@zcode/contracts";
import type {
  Logger,
  MessagePart,
  MessageWithParts,
  ModelMessageContentBlock,
  ModelReasoningContentBlock,
  MessageId,
  ToolArtifactStorePort,
  ToolPart,
} from "@zcode/contracts";
import {
  getSystemReminderDescriptor,
  wrapSystemReminderForSource,
  type SystemReminderSource,
} from "../system-reminder/source.js";
import { persistedTokenUsageBaseline } from "./message-history-usage.js";
import {
  isKnownSystemReminderSource,
  legacySyntheticRuntimeMetadata,
  realUserRuntimeMetadata,
  buildUserMessageEntries,
  type UserMessageAttachment,
  systemReminderAttachmentEntry,
  systemReminderRuntimeMetadata,
  todoReminderRuntimeMetadata,
  type MessageHistory,
  type RuntimeMessageEntry,
  type RuntimeMessageMetadata,
  type RuntimeMessageSource,
  type ToolCallInput,
} from "./message-history.js";
import { compactActiveSessionMessages, isActiveCompactionBoundaryPart } from "./compact-session.js";
import { filePartToContentBlock, projectPersistedToolMediaContent } from "./file-part-hydration.js";
import { selectToolPartsForHistory } from "./tool-part-order.js";

// [契约] 这个常量是恢复期为中断工具补的固定占位结果，不是错误文案。
// [权衡] 必须保持零信息量的稳定文本：模型据此判断该调用没有结果，而不是去猜工具状态。
// [失败路径] 若改成携带原因的错误串，旧会话每次恢复都会产生不同字符串，破坏请求前缀比对。
const INTERRUPTED_TOOL_RESULT = "[Tool execution was interrupted before resume]";

export interface SessionHistoryHydrationResult {
  appliedMessageCount: number;
  interruptedToolCount: number;
  messageCount: number;
  partCount: number;
}

export async function hydrateMessageHistoryFromSession(input: {
  logger?: Logger;
  artifactStore?: ToolArtifactStorePort;
  branchCutAfterMessageId?: MessageId;
  history: MessageHistory;
  messages: MessageWithParts[];
  rewindCreatedMessageId?: MessageId;
  rewindKeptMessageIds?: readonly MessageId[];
  rewindTargetMessageId?: MessageId;
// [契约] 返回的四个计数只用于观测与断言，不参与控制流。
// [事务] 应用条数只统计成功产出条目的消息，被跳过与被过滤的不计入。
// [失败路径] 单条消息解析失败时不会回滚已写入的 history：这里只追加，调用方必须整段丢弃。
// [权衡] 不要把计数改成遍历过的消息数，否则上层对丢消息的判断会失真。
}): Promise<SessionHistoryHydrationResult> {
  // [契约] 先算有效分支切片，再做任何水合，顺序不可交换。
  // [并发] 这里只读 messages，不原地排序也不切割：同一份 messages 可能被分叉会话与主会话同时读取。
  // [失败路径] 顺序反了会把已删除分支的部分也写进 history，provider 看到本不该存在的对话。
  const activeMessages = activeSessionMessages(input.messages, {
    branchCutAfterMessageId: input.branchCutAfterMessageId,
    rewindCreatedMessageId: input.rewindCreatedMessageId,
    rewindKeptMessageIds: input.rewindKeptMessageIds,
    rewindTargetMessageId: input.rewindTargetMessageId,
  });
  let appliedMessageCount = 0,
    interruptedToolCount = 0,
    partCount = 0;

  // [事务] 单条消息是整体成功或整体跳过的边界：用户消息要么整条走提醒出口，要么整条走条目出口。
  // [失败路径] 任一出口提前退出后都不回补空消息，provider 侧宁可少一条也不要造一条空用户消息。
  // [资源] parts 在本条消息内会被多次复用，不要在这里释放或置空。
  for (const message of activeMessages) {
    // 旧话题背景已由可查看文本附件替代；保留存储记录，但恢复时不能重新隐藏注入。
    if (
      message.info.role === "user" &&
      message.info.synthetic &&
      message.info.source === "bot_topic_context"
    )
      continue;
    // [契约] 先去重再过滤：同一部分标识在持久化里可能重复写入，重复文本会让模型看到两遍同样的提醒。
    // [权衡] 过滤只针对旧话题背景的合成文本，不能扩大到所有合成文本——公告与提醒必须保留。
    // [失败路径] 过滤在部分计数之前完成，因此计数反映的是 provider 可见部分数，不是存储部分数。
    const parts = dedupeParts(message.parts).filter(
      (part) =>
        !(
          part.type === "text" &&
          part.synthetic &&
          metadataFromSyntheticTextPart(part).source === "bot_topic_context"
        ),
    );
    partCount += parts.length;

    // [契约] 用户消息只有两条互斥出口：整条提醒附件，或普通条目列表。
    // [事务] 两条出口都提前退出消息循环，交叉执行会让同一条消息既当提醒又当用户正文。
    // [失败路径] 出口判定依赖 parts 已去重，未去重时单条消息可能同时命中两条出口。
    if (message.info.role === "user") {
      // [事务] 共享上下文状态只认持久化元数据里的专用字段，不从 parts 或界面状态推断。
      // [权衡] 未知状态若按已附加处理会误删正常消息，所以只有显式非附加才跳过。
      // [失败路径] 跳过发生在写入之前，因此待定候选绝不会进入 provider history。
      const sharedContextStatus =
        message.info.source === "shared_context" &&
        message.info.metadata &&
        typeof message.info.metadata === "object"
          ? (message.info.metadata as Record<string, unknown>).sharedContextStatus
          : undefined;
      if (
        message.info.source === "shared_context" &&
        sharedContextStatus !== undefined &&
        sharedContextStatus !== "attached"
      ) {
        // Share handover 的 pending/reserved context 只是本地候选，不能在用户首次
        // 发送前偷偷进入 provider history；attach 后由 runtime 显式注入一次。
        continue;
      }
      // session 持久化的是 raw synthetic notice，hydrate 阶段若提前包成
      // user <system-reminder>，后续 mid-conversation system projection 会失去 attachment source。
      // [契约] 只有去掉被忽略文本后恰好剩一个合成文本部分的消息，才整条升级为提醒附件。
      // [并发] 升级后立刻退出本条循环，不再产生普通用户条目，避免同一内容被两条路径写两次。
      // [失败路径] 提前把裸文本当用户正文写入，会让会话中途的系统投影找不到附件来源。
      const syntheticAttachment = syntheticSystemReminderAttachmentFromParts(parts);
      if (syntheticAttachment) {
        input.history.addEntries([syntheticAttachment]);
        appliedMessageCount++;
        continue;
      }

      // [契约] 普通用户路径产物是条目数组：零到多条提示附件，加至多一条真实用户信封。
      // [资源] 文件部分在这里逐块解析落盘内容，是恢复期最慢的一步，不要在外层再并发展开。
      // [失败路径] 空数组代表整条消息对 provider 无意义，直接跳过而不是写空用户消息。
      const entries = await userEntriesFromParts(parts, input.artifactStore);
      if (entries.length === 0) continue;
      const presentation = runtimeInputMetadata(
        (message.info.metadata as Record<string, unknown> | undefined)?.inputPresentation,
      );
      // [契约] 压缩边界信息只从部分上取，不从消息元数据猜。
      // [失败路径] 只有压缩类型的部分才产出边界，其它边界部分只是裁剪标记。
      // [权衡] 一条消息出现多个边界时只取第一个，顺序由 parts 顺序决定。
      const boundaryPart = parts.find(isActiveCompactionBoundaryPart);
      const compactBoundary =
        boundaryPart?.type === "compaction"
          ? hydrateCompactDiscovery(boundaryPart.compactBoundary)
          : undefined;
      // [事务] 边界只挂到首条条目，且展开顺序是 legacy 默认值在前、持久化元数据在后。
      // [契约] 后写的元数据覆盖默认值，这样老会话的来源与压缩发现信息都能保留。
      // [失败路径] 纯附件消息没有首条条目，边界无处可挂，这是已知且可接受的丢失。
      if (compactBoundary && entries[0]) {
        entries[0] = {
          ...entries[0],
          metadata: {
            ...legacySyntheticRuntimeMetadata(),
            ...entries[0].metadata,
            compactBoundary,
          },
        };
      }
      // [契约] 这里才真正写入 history，写入的是同一条消息的全部条目，顺序与 parts 一致。
      // [权衡] 展示元数据只叠加到非附件条目，附件类型不能被展示信息改写。
      // [并发] 写入是同步追加，中途失败会留下半条消息，调用方按整段丢弃处理。
      input.history.addEntries(
        presentation
          ? entries.map((entry) =>
              entry.kind === "attachment"
                ? entry
                : { ...entry, metadata: { ...entry.metadata, ...presentation } },
            )
          : entries,
      );
      appliedMessageCount++;
      continue;
    }

    // [契约] assistantTextFromParts / assistantReasoningFromParts / 工具部分三个投影互不替代，缺失任一也不会影响其它。
    // [资源] 推理块整段复制部分元数据，内存放大明显，但恢复期必须保真。
    // [失败路径] 正文拼接固定用双换行，改分隔符会改变所有历史请求的字节序列。
    const text = assistantTextFromParts(parts);
    const reasoning = assistantReasoningFromParts(parts);
    // [契约] 工具部分的 provider 顺序由选择器决定，不按 parts 原始落盘顺序。
    // [并发] 并发工具调用在同一助手消息里可能交错落盘，重排是恢复正确性的前提。
    // [失败路径] 就地排序 parts 会改变上面正文与推理的遍历顺序，产生不同的 provider 文本。
    const toolParts = selectToolPartsForHistory(parts.filter(isToolPart));
    // live history 会保留带合法 provider usage 的空 assistant 作为估算锚点，
    // 旧 hydration 却无条件丢弃它，导致重启前后的 context estimate 不一致。
    if (
      text.trim().length === 0 &&
      reasoning.length === 0 &&
      toolParts.length === 0 &&
      !persistedTokenUsageBaseline(message.info.tokens)
    ) {
      continue;
    }

    input.history.addAssistant(
      text,
      toolParts.map(
        (part): ToolCallInput => ({
          id: part.callID,
          input: part.state.input,
          modelCallWrapper: modelCallWrapperFromPart(part),
          name: historyToolNameFromPart(part),
        }),
      ),
      reasoning,
      message.info.modelId && message.info.providerId
        ? { modelId: message.info.modelId, providerId: message.info.providerId }
        : undefined,
      message.info.tokens,
    );
    appliedMessageCount++;

    for (const part of toolParts) {
      const toolName = historyToolNameFromPart(part);
      const modelCallWrapper = modelCallWrapperFromPart(part);
      // [契约] 完成分支三级回退固定：结构化内容、布局投影、输出摘要，顺序不可调换。
      // [权衡] 三级都不能省：省掉第一级丢结构化内容，省掉第二级丢媒体，省掉第三级让老会话无内容可用。
      // [失败路径] 回退是逐级兜底而非合并，任何一级命中都不会再拼接下一级。
      if (part.state.status === "completed") {
        // live tool result 使用结构化媒体，但旧恢复只读取 output 摘要，
        // 导致模型切换或冷恢复后丢失 Read/MCP 产生的真实媒体。
        const attachmentBlocks = part.state.attachments
          ? await Promise.all(
              part.state.attachments.map((attachment) =>
                filePartToContentBlock(attachment, input.artifactStore),
              ),
            )
          : [];
        // 旧 completed part 也可能有 attachments；只有完整有效的 layout 才能证明
        // 它们属于新的 provider-visible 媒体内容，缺失或损坏时必须保留 legacy output。
        // [事务] 只有附件解析出至少一个块时才尝试布局投影，空附件不允许伪造媒体内容。
        // [失败路径] 布局缺失或损坏时投影结果为空，自动滑落到输出摘要，而不是拼半截媒体。
        // [契约] 投影必须完整匹配布局，缺一个块就整体作废。
        const projectedMediaContent =
          attachmentBlocks.length > 0
            ? projectPersistedToolMediaContent(
                part.state.metadata?.modelContentLayout,
                attachmentBlocks,
              )
            : undefined;
        // [契约] 这里的顺序就是线上载荷顺序，改一行等于改所有冷恢复会话的 provider 输入。
        // [失败路径] 结构化内容是空字符串也算命中，不能退化成真假判断，否则空内容会被摘要覆盖。
        // [资源] 命中的字符串直接引用，不再复制，避免大输出在恢复期被二次内存放大。
        const content =
          hydrateToolSearchContent(part.state.metadata?.modelContent, input.logger) ??
          projectedMediaContent ??
          part.state.output;
        input.history.addToolResult(part.callID, toolName, content, true, false, modelCallWrapper);
        continue;
      }

      // [契约] 错误结果统一带失败标记，并把持久化结构化内容优先于界面错误文案。
      // [失败路径] 界面错误文案是给渲染与日志的，直接回灌会让模型看到人话而不是机器格式错误。
      // [权衡] 两者都缺失时仍写入空串，保证每个调用都有配对结果。
      if (part.state.status === "error") {
        const persistedModelContent = part.state.metadata?.modelContent;
        // 实时链路使用 ToolExecutionResult.modelContent，但旧恢复逻辑只重放
        // 面向 UI / 日志的 state.error；优先使用持久化字符串并兼容旧 session。
        input.history.addToolResult(
          part.callID,
          toolName,
          typeof persistedModelContent === "string" ? persistedModelContent : part.state.error,
          false,
          true,
          modelCallWrapper,
        );
        continue;
      }

      // [事务] 未完成工具必须补一条结果占位，否则 provider 会因为调用没有配对结果直接拒答。
      // [契约] 占位文本取自常量，且标记为失败但非合成，与真实失败结果可区分。
      // [失败路径] 这是唯一凭空造内容的地方，文本必须与所有真实输出都不冲突。
      interruptedToolCount++;
      input.history.addToolResult(
        part.callID,
        toolName,
        INTERRUPTED_TOOL_RESULT,
        false,
        true,
        modelCallWrapper,
      );
    }
  }

  return {
    appliedMessageCount,
    interruptedToolCount,
    messageCount: activeMessages.length,
    partCount,
  };
}

// [契约] 选枝与裁剪的唯一入口，调用方只允许通过它拿可见消息，不允许自行切片。
// [并发] 纯函数、无副作用、只读输入数组，分叉会话与主会话可共享同一份 messages。
// [失败路径] 直接复用分支选择而不做压缩裁剪，会把已压缩段落重新送进 provider。
export function activeSessionMessages(
  messages: MessageWithParts[],
  options: {
    branchCutAfterMessageId?: MessageId;
    includeCompactPreservedSegment?: boolean;
    rewindCreatedMessageId?: MessageId;
    rewindKeptMessageIds?: readonly MessageId[];
    rewindTargetMessageId?: MessageId;
  } = {},
): MessageWithParts[] {
  // [契约] 无分支切点的旧数据走 legacy 顺序：先压缩再选枝，新数据正好相反。
  // [失败路径] 两种顺序不能统一：旧数据的保留标识可能位于压缩之前，按新顺序解释会丢消息。
  // [权衡] 看似可以合并成一条路径，改了会让老会话冷恢复结果与历史版本不一致。
  if (!options.branchCutAfterMessageId) {
    // 旧数据没有 branch cut，继续使用 compact-first/createdMessageID 兼容语义；不能把
    // 历史上非法的 compact 前 kept IDs 解释成新式 branch，从而改变既有冷恢复结果。
    let legacyCompactIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]!.parts.some(isActiveCompactionBoundaryPart)) {
        legacyCompactIndex = index;
        break;
      }
    }
    const compactActiveMessages =
      legacyCompactIndex >= 0
        ? compactActiveSessionMessages(
            messages,
            legacyCompactIndex,
            options.includeCompactPreservedSegment !== false,
          )
        : messages;
    // [事务] 回滚保留集合全部落在压缩之前时，说明回滚点已被压缩吞掉，只能返回压缩结果。
    // [契约] 这里只做集合交集判断，不重扫消息体，语义依赖消息标识稳定。
    // [失败路径] 交集非空时继续走分支选择，不能因为存在回滚参数就跳过选枝。
    if (options.rewindKeptMessageIds && legacyCompactIndex >= 0) {
      const postCompactIds = new Set(
        messages.slice(legacyCompactIndex).map((message) => message.info.id),
      );
      if (!options.rewindKeptMessageIds.some((messageId) => postCompactIds.has(messageId))) {
        return compactActiveMessages;
      }
    }
    return selectActiveConversationBranch(compactActiveMessages, options);
  }

  // 最后一个 compact boundary。顺序相反会让 compact 前 kept prefix 永远无法恢复。
  const branchActiveMessages = selectActiveConversationBranch(messages, options);
  let lastCompactionIndex = -1;
  for (let index = branchActiveMessages.length - 1; index >= 0; index--) {
    if (branchActiveMessages[index]!.parts.some(isActiveCompactionBoundaryPart)) {
      lastCompactionIndex = index;
      break;
    }
  }
  return lastCompactionIndex >= 0
    ? compactActiveSessionMessages(
        branchActiveMessages,
        lastCompactionIndex,
        options.includeCompactPreservedSegment !== false,
      )
    : branchActiveMessages;
}

// [契约] 去重键固定为部分标识，后出现者覆盖先出现者，不比较内容。
// 按 part.id 去重是唯一正确键：若改成按内容比对，用户重发同一条 prompt 会在历史里少一条。
// [失败路径] 除顺序外不保证任何性质，调用方不能依赖被覆盖的那一份部分。
function dedupeParts(parts: MessagePart[]): MessagePart[] {
  const byId = new Map<string, MessagePart>();
  for (const part of parts) {
    byId.set(part.id, part);
  }
  return [...byId.values()];
}

// [契约] 输出三段拼接顺序固定：真实用户信封、合成提醒附件、提示附件。
// [资源] 文件部分逐个等待解析，串行执行，保证附件顺序与用户选择顺序一致。
// [失败路径] 单个附件解析失败会让整条消息恢复失败，不允许静默跳过单个块。
async function userEntriesFromParts(
  parts: MessagePart[],
  artifactStore: ToolArtifactStorePort | undefined,
): Promise<RuntimeMessageEntry[]> {
  const attachments: UserMessageAttachment[] = [];
  const promptBlocks: ModelMessageContentBlock[] = [];
  const syntheticAttachmentEntries: RuntimeMessageEntry[] = [];

  for (const part of parts) {
    if (part.type === "text" && !part.ignored) {
      const syntheticAttachment = syntheticSystemReminderAttachmentFromTextPart(part);
      if (syntheticAttachment) {
        syntheticAttachmentEntries.push(syntheticAttachment);
        continue;
      }
      promptBlocks.push({ type: "text", text: textPartToProviderText(part) });
      continue;
    }

    if (part.type === "file") {
      attachments.push({
        ...part,
        contentBlock: await filePartToContentBlock(part, artifactStore),
      });
      continue;
    }

    if (part.type === "agent") {
      promptBlocks.push({ type: "text", text: `[Selected agent: ${part.name}]` });
    }
  }

  // [契约] 有附件时把块数组原样交给上层，无附件时把文本块用双换行拼成单串。
  // [权衡] 两种形态不能混用：有附件仍拼串会让附件与正文顺序错位。
  // [失败路径] 空文本块在拼串时被过滤掉，但块形态下会原样保留，这是有意的差异。
  const prompt =
    attachments.length > 0
      ? promptBlocks
      : promptBlocks
          .map((block) => (block.type === "text" ? block.text : ""))
          .filter(Boolean)
          .join("\n\n");
  // [契约] buildUserMessageEntries 的第一项才是真实用户信封，其余条目一律降级为 prompt_attachment。
  // [事务] 信封是否保留取决于正文去空白后是否非空，或来源为真实用户且确有附件条目。
  // [失败路径] 按条目数量判断会把纯合成消息恢复成空用户消息。
  const [userEntry, ...promptAttachmentEntries] = buildUserMessageEntries(prompt, attachments);
  const content = userEntry.message.content;
  const hasUserContent = modelMessageContentToText(content).trim().length > 0;
  const userMetadata = metadataFromUserParts(parts);
  // 文本附件从原始 file part 恢复为 prompt_attachment 后，空正文的
  // real_user envelope 曾被 trim 判空丢弃，导致 live 与 resume 的 provider history 不一致。
  // 这里只恢复 Agent 内存锚点；bare-empty 和纯 synthetic/meta user 仍不生成空消息。
  // [契约] 返回非空用户消息的闸门是 shouldRestoreRealUserEnvelope 为真，或合成 / 提示附件条目非空，否则返回空。
  // [失败路径] 三者都不满足时返回空数组，绝不产出裸空用户消息。
  // [事务] 这是实时链路与恢复链路一致性最容易被打破的一处，改动必须双向验证。
  const shouldRestoreRealUserEnvelope =
    hasUserContent || (userMetadata.source === "real_user" && promptAttachmentEntries.length > 0);
  if (
    !shouldRestoreRealUserEnvelope &&
    syntheticAttachmentEntries.length === 0 &&
    promptAttachmentEntries.length === 0
  ) {
    return [];
  }
  return [
    ...(shouldRestoreRealUserEnvelope
      ? [
          {
            message: { role: "user" as const, content },
            metadata: userMetadata,
          },
        ]
      : []),
    ...syntheticAttachmentEntries,
    ...promptAttachmentEntries,
  ];
}

// [契约] 已包裹的提醒原样返回，普通正文原样返回，只有特定来源才二次包裹。
// [失败路径] 重复包裹会产生嵌套提醒标签，模型会把提醒当成用户原话。
// [权衡] 任务状态来源还要排除后台任务标记，否则后台完成通知会被误包。
function textPartToProviderText(part: Extract<MessagePart, { type: "text" }>): string {
  if (!part.synthetic) {
    return part.text;
  }
  if (isProviderWrappedSystemReminderText(part.text)) {
    return part.text;
  }

  const runtimeMetadata = runtimeMessageMetadataFromPartMetadata(part.metadata);
  if (runtimeMetadata?.source === "task_status" && part.metadata?.source !== "background_task") {
    return wrapSystemReminderForSource("task_status", part.text);
  }
  if (
    runtimeMetadata?.source === "queued_system_notification" ||
    part.metadata?.source === "subagent"
  ) {
    // subagent notification 同样只在 provider history 恢复时包外层，避免改动 session/UI raw transcript。
    return wrapSystemReminderForSource("queued_system_notification", part.text);
  }
  return part.text;
}

type SyntheticSystemReminderAttachment = ReturnType<typeof systemReminderAttachmentEntry>;

function syntheticSystemReminderAttachmentFromParts(
  parts: MessagePart[],
): SyntheticSystemReminderAttachment | undefined {
  const visibleParts = parts.filter((part) => !(part.type === "text" && part.ignored));
  if (visibleParts.length !== 1) return undefined;

  const part = visibleParts[0]!;
  if (part.type !== "text" || !part.synthetic) return undefined;
  return syntheticSystemReminderAttachmentFromTextPart(part);
}

// [契约] 只接受已校验的来源，且必须满足元数据、provider 可见、非真实用户、非工具结果四个条件。
// [事务] 已包裹但拿不到公告身份时返回空，交回普通正文路径处理。
// [失败路径] 只有公告身份确认后才剥掉外层标签，剥壳顺序反了会留下半个标签。
// [权衡] 空白文本直接判空丢弃，避免空提醒进入 provider。
function syntheticSystemReminderAttachmentFromTextPart(
  part: Extract<MessagePart, { type: "text" }>,
): SyntheticSystemReminderAttachment | undefined {
  if (!part.synthetic) return undefined;
  if (part.text.trim().length === 0) return undefined;
  const metadata = metadataFromSyntheticTextPart(part);
  // 只凭已校验的公告身份适配旧包装，不从普通用户正文推断提醒来源。
  const announcement = metadata.toolSearchAnnouncement;
  const wrapped = isProviderWrappedSystemReminderText(part.text);
  if (wrapped && !announcement) return undefined;
  if (!isRestorableSystemReminderAttachmentSource(metadata.source)) return undefined;

  return {
    ...systemReminderAttachmentEntry(
      metadata.source,
      wrapped && announcement
        ? part.text
            .trim()
            .replace(/^<system-reminder>\s*/, "")
            .replace(/\s*<\/system-reminder>$/, "")
        : part.text,
    ),
    metadata,
  };
}

function isRestorableSystemReminderAttachmentSource(
  source: RuntimeMessageSource,
): source is SystemReminderSource {
  if (!isKnownSystemReminderSource(source)) return false;
  const descriptor = getSystemReminderDescriptor(source);
  return (
    descriptor.isMeta &&
    descriptor.providerVisibility === "provider_visible" &&
    descriptor.channel !== "real_user" &&
    descriptor.channel !== "tool_result"
  );
}

function isProviderWrappedSystemReminderText(text: string): boolean {
  return text.trimStart().startsWith("<system-reminder");
}

// [契约] 有真实用户文本或结构化部分就判为真实用户来源。
// [权衡] 纯合成消息回落到该合成部分的元数据，不能一律当真实用户。
// [失败路径] 没有任何可见文本部分时仍返回真实用户来源，作为兜底。
function metadataFromUserParts(parts: MessagePart[]): RuntimeMessageMetadata {
  const visibleTextParts = parts.filter(
    (part): part is Extract<MessagePart, { type: "text" }> => part.type === "text" && !part.ignored,
  );
  const hasRealUserText = visibleTextParts.some((part) => !part.synthetic);
  const hasStructuredUserPart = parts.some((part) => part.type === "file" || part.type === "agent");
  if (hasRealUserText || hasStructuredUserPart) {
    return realUserRuntimeMetadata();
  }

  const syntheticTextPart = visibleTextParts.find((part) => part.synthetic);
  if (!syntheticTextPart) {
    return realUserRuntimeMetadata();
  }

  return metadataFromSyntheticTextPart(syntheticTextPart);
}

// [契约] 优先级固定：后台任务与子消息的 legacy 覆盖、持久化元数据、已知来源映射、legacy 兜底。
// [失败路径] 持久化元数据优先，防止新版本把老会话的后台完成通知重新包成提醒。
// [权衡] 来源映射只覆盖已知来源，未知来源一律降级为 legacy，不抛错。
function metadataFromSyntheticTextPart(
  part: Extract<MessagePart, { type: "text" }>,
): RuntimeMessageMetadata {
  const source = part.metadata?.source;
  if (source === "background_task" || source === "subagent_message") {
    // runtime command carrier 对齐直接 user-like 注入；即使旧持久化里带过
    // system reminder metadata，恢复时也不能把后台完成或 child 回复重新包成 reminder。
    return legacySyntheticRuntimeMetadata();
  }

  const persistedRuntimeMetadata = runtimeMessageMetadataFromPartMetadata(part.metadata);
  if (persistedRuntimeMetadata) {
    return persistedRuntimeMetadata;
  }

  if (source === "subagent") {
    return systemReminderRuntimeMetadata("queued_system_notification");
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (source === "goal-continuation") {
    return systemReminderRuntimeMetadata("target_continuation");
  }
  if (source === "rewind" || source === "fork") {
    return systemReminderRuntimeMetadata("rewind_notice");
  }
  if (isKnownSystemReminderSource(source)) {
    return systemReminderRuntimeMetadata(source);
  }

  return legacySyntheticRuntimeMetadata();
}

// [契约] 只认元数据里嵌套的运行时消息字段，其它位置的同名字段一律不信。
// [事务] 展示元数据命中即返回，不再看来源，因为展示信息已完整描述出处。
// [失败路径] 增量解析走 schema 校验，失败时保留来源但不带增量，避免整条消息不可用。
// [权衡] 非对象值直接视为缺失，不做宽松猜测。
function runtimeMessageMetadataFromPartMetadata(
  metadata: Record<string, unknown> | undefined,
): RuntimeMessageMetadata | undefined {
  const runtimeMessage = metadata?.runtimeMessage;
  if (!isRecord(runtimeMessage)) return undefined;

  const presentation = runtimeInputMetadata(runtimeMessage.inputPresentation);
  if (presentation) return presentation;
  const source = runtimeMessage.source;
  if (source === "agent_listing_delta") {
    const delta = parseAgentListingDelta(runtimeMessage.agentListingDelta);
    return { source, ...(delta ? { agentListingDelta: delta } : {}) };
  }
  if (source === "real_user") {
    return realUserRuntimeMetadata();
  }
  if (source === "legacy_synthetic" || source === "tool_search_announcement") {
    const announcement = hydrateToolSearchAnnouncement(runtimeMessage.toolSearchAnnouncement);
    return {
      ...legacySyntheticRuntimeMetadata(),
      ...(announcement
        ? { source: "tool_search_announcement" as const, toolSearchAnnouncement: announcement }
        : {}),
    };
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (isKnownSystemReminderSource(source)) {
    return systemReminderRuntimeMetadata(source);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantTextFromParts(parts: MessagePart[]): string {
  const chunks: string[] = [];

  for (const part of parts) {
    if (part.type === "text" && !part.ignored) {
      chunks.push(part.text);
    }
  }

  return chunks.join("\n\n");
}

function assistantReasoningFromParts(parts: MessagePart[]): ModelReasoningContentBlock[] {
  const blocks: ModelReasoningContentBlock[] = [];

  for (const part of parts) {
    if (part.type === "reasoning") {
      blocks.push({
        type: "reasoning",
        text: part.text,
        providerOptions: part.metadata ? { ...part.metadata } : undefined,
      });
    }
  }

  return blocks;
}

function isToolPart(part: MessagePart): part is ToolPart {
  return part.type === "tool";
}

function modelCallWrapperFromPart(part: ToolPart) {
  const parsed = ModelCallWrapperSchema.safeParse(part.metadata?.modelCallWrapper);
  return parsed.success ? parsed.data : undefined;
}

// [契约] 持久化工具名按字段存在性恢复，空字符串是合法且必须保留的值。
// [失败路径] 回落到通用工具名只发生在字段缺失或类型错误时，不能用真假判断。
// [事务] 名字不一致会让调用与结果配对失败，provider 直接拒绝整段历史。
// [权衡] 这里不做名称规范化，历史名必须原样保真。
function historyToolNameFromPart(part: ToolPart): string {
  const providerToolName = part.metadata?.providerToolName;
  // 空字符串在 cold hydration 中曾只能依赖 non-empty ToolPart.tool；
  // 必须按字段存在性恢复原值，不能用 truthy 判断把空名重新覆盖成占位值。
  return providerToolName !== undefined && typeof providerToolName === "string"
    ? providerToolName
    : part.tool;
}
