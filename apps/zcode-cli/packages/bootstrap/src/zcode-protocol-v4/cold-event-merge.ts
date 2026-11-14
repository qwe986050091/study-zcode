/**
 * ============================================================================
 * zcode-protocol-v4/cold-event-merge.ts —— 冷恢复的三源合并
 * ============================================================================
 *
 * 【职责】把三类事实合成为一条可重放的事件序列：
 *   1) durable transcript（message/part，已完成正文的唯一权威）；
 *   2) session_entry（legacy goal verify 事实，只补 transcript 没有的部分）；
 *   3) 内存 live 事件（未完成 turn、queue、hook、插件/后台等无 transcript 形态的状态）。
 *
 * 【合并顺序】durableEvents（hydrate-*）占据正文顺序；内存事件按分类追加到尾部
 * （supplements），或改写成 hydration turnId 后插入对应轮的 prefix/tail；
 * 最终统一 resequence，sequenceNumber 单调递增，保证重放顺序可复现。
 *
 * 【谁胜出】同一事实同时存在时 durable 胜出：transcript 已合成的事件按类型去重
 * （durable_event_suppressed）；compact/fork/goal boundary 用持久 key 比对；
 * queue/hook/plugin 等 memory-only 事实只在内存侧存在，必须保留或显式诊断。
 * 无法判定归属的旧 turn 宁可保留并记诊断，也不静默删除。
 *
 * 【幂等】同一输入 → 同一事件顺序与同一诊断集合；不修改入参对象
 *（改写 turnId 时创建新对象），可安全用于重连/重放。
 * ============================================================================
 */
// 冷恢复三源合并：durable transcript 是正文权威，session_entry 只补 legacy goal，内存事件只补当前状态
// 输出可直接喂 ProductProjection 的事件序列；同输入同顺序同诊断，不修改入参，可安全用于重连与重放
// 冲突口径：durable 与持久 target 胜出，memory-only 必留，无法判定归属的旧事实保留并记诊断
// INV-01 durable transcript 是已完成正文的唯一权威，内存副本只能被抑制不得覆盖；守住位置：mergeColdConversationEvents 分类遍历；改错故障：刷新后历史正文重复或跳字
// INV-02 同一输入必须产出同一事件顺序与同一诊断集合；守住位置：全文件纯函数、不依赖时间与随机；改错故障：重连重放顺序漂移、界面跳动
// INV-03 入参事件与 message 对象只读，改写 turnId 必须创建新对象；守住位置：hook 与 boundary 插入分支；改错故障：内存事件复用后 turnId 被污染，另一会话串轮
// INV-04 合并后 sequenceNumber 从 1 连续递增且无重复；守住位置：resequence；改错故障：reducer 按序号去重时丢事件或乱序
// INV-05 target 用字段是否存在区分未读取与显式 null；守住位置：hasPersistedTargetAuthority 与 MergeInput；改错故障：缺席被当清空，唯一的内存 TargetChanged 被压掉，goal 显示为空
// INV-06 持久 target 存在时必须在 SessionCreated 之后插入权威 TargetChanged；守住位置：durableEvents 构造；改错故障：冷恢复后 goal 面板回退到旧目标
// INV-07 未完成 turn 必须整体保留为内存权威；守住位置：memoryAuthorityTurnIds；改错故障：崩溃重连后 in-flight 轮次消失、用户输入丢失
// INV-08 无 messageId 且无持久 anchor 的 legacy turn 宁可保留并诊断；守住位置：ambiguousLegacyStarts 分支；改错故障：真实提交被当重复删除，历史少一轮
// INV-09 去重只允许用持久实体 ID 或持久 key，禁止文本与时间邻近猜测；守住位置：durableTurnByMessageId 与 goalKey；改错故障：相同文本的两次提交被合并成一轮
// INV-10 compact/fork/goal 三类 boundary key 必须与 durable 副本逐一对齐；守住位置：durableBoundaryKeys 与 durableBoundaryKeyForEvent；改错故障：压缩边界重复出现或分叉记录丢失
// INV-11 memory-only 事件（session/mode/permission/background/dwf）必须原样保留；守住位置：MEMORY_ONLY_EVENT_TYPES 分支；改错故障：重连后权限请求与后台任务行消失
// INV-12 live-only 插件 UI 事件在冷恢复必须丢弃并计数；守住位置：LIVE_ONLY_EVENT_TYPES 分支；改错故障：指向已销毁沙箱的实例行残留或被反复重试
// INV-13 transcript 可重建的事件，其内存副本一律抑制并计数；守住位置：TRANSCRIPT_DERIVED_EVENT_TYPES 分支；改错故障：正文与工具卡在重放后出现两份
// INV-14 未 settled 的 queue id 需保留自最近 admission 起的完整生命周期；守住位置：queueStateEventIndexes；改错故障：冷恢复后待发消息丢附件与 intent、顺序错乱
// INV-15 settled 生命周期与 reorder/autoDrain/followupMode 只保留最后一条；守住位置：queueStateEventIndexes 尾部筛选；改错故障：队列重复入场或策略回退
// INV-16 resumed 型 subagent lifecycle 必须保留 spawn 与 stop 配对；守住位置：resumedSubagentLifecycleEventIndexes；改错故障：重连后侧栏子代理行与停止按钮消失
// INV-17 hook 归属只按 runtime turn 与持久 message boundary 顺序推进，解析后冻结；守住位置：durableHookTurnByInvocationId；改错故障：后台终态跨轮错挂，hook 卡片出现在别的轮
// INV-18 同一 runtime anchor 指向多个 hydration turn 时必须判歧义不映射；守住位置：durableTurnByRuntimeAnchor；改错故障：事件挂错轮，正文与工具输出对不上
// INV-19 无可判定归属的未知事件必须保留并聚合诊断，禁止静默删除；守住位置：末尾 unclassified 分支；改错故障：老 session 冷恢复悄悄丢状态且无告警
import {
  SessionEventType,
  selectActiveConversationBranch,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionEvent,
  type SessionGoal,
  type TurnFileChangeSummary,
  type TurnId,
} from "@zcode/contracts";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  goalVerificationEntriesFromSessionEntries,
  synthesizeEventsFromMessages,
  type HydratedGoalVerificationEntry,
} from "./transcript-hydration.js";

/**
 * 持久层可提供的全部冷恢复原料。
 * messages 必须已按 active branch 裁剪；target 用"字段是否存在"区分
 * "未读取"与"明确 null"，避免把缺席当清空。
 */
// [权衡] target 用字段是否存在区分未读取与明确 null，缺席表示没有持久权威
// [失败路径] 把缺席当清空会压掉内存 TargetChanged，重连后 goal 直接显示为空
// [并发] messages 必须是已按 active branch 裁剪后的集合，否则回滚分支会被复活
// [资源] memoryEvents 以浅拷贝下发，调用方后续追加不会污染调用者持有的事件数组
export interface ConversationMaterializationSource {
  goalVerificationEntries: HydratedGoalVerificationEntry[];
  memoryEvents: SessionEvent[];
  messages: MessageWithParts[];
  /** shared_context 正文仍是 provider-only；这里只下发脱敏的 handover metadata。 */
  sharedContextImport?: ConversationSnapshot["sharedContextImport"];
  /** 只有成功读取 session_target 后才存在；显式 null 也是持久 authority。 */
  target?: SessionGoal | null;
}

// [事务] 多个只读查询必须来自同一持久视图，并行发起但不跨提交拼接结果
// [权衡] sessionEntries 可选：老 store 没有该能力时按空集处理而非整体失败
// [失败路径] readTarget 抛错必须向上冒泡，不能降级成 null 伪造已清空
// [资源] revert 字段只用于裁剪分支，不进入投影，避免回滚元数据泄露到前端
interface PersistedConversationMaterializationStore {
  getSession(sessionId: import("@zcode/contracts").SessionId): Promise<{
    title?: string;
    revert?: {
      branchCutAfterMessageID?: import("@zcode/contracts").MessageId;
      branchGeneration?: number;
      createdMessageID?: import("@zcode/contracts").MessageId;
      keptMessageIDs?: import("@zcode/contracts").MessageId[];
      targetMessageID?: import("@zcode/contracts").MessageId;
    };
  } | null>;
  messages(input: { sessionID: import("@zcode/contracts").SessionId }): Promise<MessageWithParts[]>;
  readTarget(input: {
    sessionID: import("@zcode/contracts").SessionId;
  }): Promise<SessionGoal | null>;
  sessionEntries?(input: {
    sessionID: import("@zcode/contracts").SessionId;
    type?: string;
  }): Promise<SessionEntryInfo[]>;
}

/**
 * cold materialization 的单一持久事实入口。
 *
 * 旧 bridge 只读取全量 message/part，既没有读取 session.revert 来裁掉
 * 已回滚分支，也没有读取 session_target；结果 runtime resume / stable fork 已经使用
 * active branch，而刷新 projection 却会复活旧分支并把 goal 恢复成 null。
 */
// [并发] 四个只读查询并行发起，缩短冷启动首屏等待时间
// [权衡] persistedMessages 允许调用方预取注入，避免同一份全量消息读两遍
// [失败路径] store 缺席时返回空 messages，由合并层决定如何保住内存事实
// [事务] 该函数不写库也不缓存，读写职责分离，重试无副作用
export async function loadPersistedConversationMaterialization(input: {
  memoryEvents: readonly SessionEvent[];
  persistedMessages?: MessageWithParts[];
  sessionId: string;
  store?: PersistedConversationMaterializationStore;
}): Promise<ConversationMaterializationSource> {
  // [失败路径] 没有 sessionStore 时不得伪造 target 为 null，否则等于宣称持久层已清空
  // [权衡] 该分支只回传内存事件、正文留空，宁可少画也不画错
  // [事务] 空目标集与空消息集是明确的降级结果，不携带任何隐式默认值
  // [资源] 返回的事件数组是新数组，调用方追加不会改变入参 memoryEvents
  if (!input.store) {
    // 无 sessionStore 时旧 bridge 人工填 target:null，把“没有读取”误当成
    // “持久层明确清空”，进而压掉唯一的内存 TargetChanged 并强制 synthesized。
    return {
      goalVerificationEntries: [],
      memoryEvents: [...input.memoryEvents],
      messages: [],
    };
  }
  const sessionID = input.sessionId as import("@zcode/contracts").SessionId;
  const [session, allMessages, target, entries] = await Promise.all([
    input.store.getSession(sessionID),
    input.persistedMessages ?? input.store.messages({ sessionID }),
    input.store.readTarget({ sessionID }),
    input.store.sessionEntries ? input.store.sessionEntries({ sessionID }) : Promise.resolve([]),
  ]);
  // [事务] 裁剪依据 session.revert 的四个字段，保证投影与 runtime resume 落在同一条分支
  // [失败路径] 不裁剪会让刷新后的 projection 复活已回滚消息，用户看到撤回过的内容
  // [权衡] 复用 contracts 的同一选择器，避免两处分支算法各自漂移
  // [并发] 裁剪是纯函数，同一消息集合可被多次调用而不产生共享可变状态
  const messages = selectActiveConversationBranch(allMessages, {
    branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session?.revert?.createdMessageID,
    rewindKeptMessageIds: session?.revert?.keptMessageIDs,
    rewindTargetMessageId: session?.revert?.targetMessageID,
  });
  const sharedContextMessage = messages.find(
    (message) =>
      message.info.role === "user" &&
      message.info.source === "shared_context" &&
      message.info.semantics?.origin === "import" &&
      message.info.semantics?.kind === "shared_context",
  );
  const sharedContextEntry = entries.find((entry) => entry.type === "v4/shared_context_import");
  const sharedContextData =
    sharedContextEntry?.data && typeof sharedContextEntry.data === "object"
      ? (sharedContextEntry.data as Record<string, unknown>)
      : undefined;
  const contextId =
    typeof sharedContextData?.contextId === "string" ? sharedContextData.contextId : undefined;
  const shareUrl =
    typeof sharedContextData?.shareUrl === "string" ? sharedContextData.shareUrl : undefined;
  const status = sharedContextData?.status;
  // [资源] shared_context 正文仍是 provider-only，这里只下发脱敏的 handover metadata
  // [失败路径] 缺 title 或缺持久 entry 时整体退化为 undefined，不拼接半份快照
  // [权衡] status 必须落在白名单内才采信，脏数据按缺省处理而非原样透传
  // [并发] 只读已裁剪消息与持久 entry，不发起额外 I/O，避免冷启动多一次往返
  const sharedContextImport =
    sharedContextMessage && session?.title?.trim()
      ? contextId &&
        shareUrl &&
        ["pending", "reserved", "attached", "discarded"].includes(String(status))
        ? {
            contextId,
            title: session.title.trim(),
            shareUrl,
            status: status as "pending" | "reserved" | "attached" | "discarded",
          }
        : { title: session.title.trim() }
      : undefined;
  return {
    goalVerificationEntries: goalVerificationEntriesFromSessionEntries(entries),
    memoryEvents: [...input.memoryEvents],
    messages,
    ...(sharedContextImport ? { sharedContextImport } : {}),
    target,
  };
}

/** 合并过程的聚合诊断：同一 code 计数并按事件类型细分，调用方据此观测降级。 */
// [事务] 诊断按 code 聚合，同 code 累加计数并按事件类型细分
// [失败路径] 缺任一 code 会让降级不可观测，调用方无法区分正常与静默丢失
// [权衡] 只存 code 与计数、不携带 payload，避免诊断本身泄露用户内容
// [权衡] 诊断不预排序，调用方按 code 聚合后自行稳定排序，内核不假设 UI 顺序
export interface ColdEventMergeDiagnostic {
  code:
    | "cold_merge.durable_event_suppressed"
    | "cold_merge.ambiguous_legacy_turn_preserved"
    | "cold_merge.settled_queue_event_suppressed"
    | "cold_merge.memory_boundary_preserved"
    | "cold_merge.non_product_event_suppressed"
    | "cold_merge.unclassified_event_preserved";
  count: number;
  eventTypes: Record<string, number>;
}

/**
 * 合并结果：可直接喂给 ProductProjection 的事件序列 + 降级诊断。
 * usedDurableTranscript 表示本次是否用到了任何持久正文/目标，供调用方选择缓存策略。
 */
export interface ColdEventMergeResult {
  diagnostics: ColdEventMergeDiagnostic[];
  events: SessionEvent[];
  usedDurableTranscript: boolean;
}

/** 三源合并输入；target 采用可选字段以区分"未读取"与"持久层明确 null"。 */
interface MergeInput {
  contextWindow?: number;
  fileChangeSummariesByMessageId?: ReadonlyMap<string, TurnFileChangeSummary>;
  goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  memoryEvents: readonly SessionEvent[];
  messages: readonly MessageWithParts[];
  sessionId: string;
  target?: SessionGoal | null;
}

// 只对当时存活沙箱实例有意义；冷恢复没有受众，直接丢弃。
const LIVE_ONLY_EVENT_TYPES = new Set<string>([
  SessionEventType.PluginUiResourceUpdated,
  SessionEventType.PluginUiResourceListChanged,
  SessionEventType.PluginUiAppToolCallRequested,
  SessionEventType.PluginUiInstanceClosed,
]);

// 权威只在内存/journal，transcript 从不合成；冷恢复必须原样保留。
// [事务] 这些事件的权威只在内存或 journal，transcript 从不合成，必须整条保留
// [失败路径] 漏登记不会丢事件（兜底分支同样保留），但每次冷恢复刷一条 unclassified 诊断
// [权衡] 反复出现的假诊断会淹掉真正的词汇表漏登信号，故需显式登记
// [资源] 集合是模块级常量，热路径 O(1) 命中判断，不产生逐事件临时分配
const MEMORY_ONLY_EVENT_TYPES = new Set<string>([
  SessionEventType.SessionResumed,
  SessionEventType.SessionTitleUpdated,
  SessionEventType.SessionModeChanged,
  SessionEventType.PermissionRequested,
  SessionEventType.PermissionResolved,
  SessionEventType.PermissionDenied,
  SessionEventType.UserInputAutoResolutionUpdated,
  SessionEventType.BackgroundTaskStarted,
  SessionEventType.BackgroundTaskUpdated,
  SessionEventType.BackgroundTaskCompleted,
  // workflow run 进度：权威事实在 dwf_event journal 与内存事件里，durable transcript（message/part）
  // 从不合成它，所以它与 BackgroundTask* 同类——memory-only 权威。不分类的后果不是丢事件
  // （兜底分支同样保留），而是每次冷恢复刷一条 unclassified 诊断，把"真的漏了词汇表"这个
  // 信号淹掉。
  SessionEventType.DynamicWorkflowRunProgress,
  SessionEventType.TargetChanged,
  SessionEventType.RewindTriggered,
  SessionEventType.TurnExecutionModelFallback,
]);

// 这些事件可由 durable transcript 完整重建；内存副本按重复抑制。
// [事务] 登记集合内的内存副本视为 durable 的重复投影，一律抑制并计数
// [失败路径] 漏登记的重复项不会被删，只会多一条诊断，方向安全
// [权衡] 抑制判据是事件类型而非内容，避免按 payload 相似度猜同一性
// [事务] 抑制发生在改写 turnId 之前，避免把重复事件先挂进轮再丢弃
const TRANSCRIPT_DERIVED_EVENT_TYPES = new Set<string>([
  SessionEventType.SessionCreated,
  SessionEventType.TurnStarted,
  SessionEventType.ModelSelected,
  SessionEventType.ModelStreaming,
  SessionEventType.ModelComplete,
  SessionEventType.ToolCallScheduled,
  SessionEventType.ToolCallStarted,
  SessionEventType.ToolCallResult,
  SessionEventType.ToolCallError,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
  SessionEventType.CompactStarted,
  SessionEventType.CompactCompleted,
  SessionEventType.CompactFailed,
  SessionEventType.TargetCompletionVerification,
  SessionEventType.SessionForked,
  SessionEventType.SubagentSpawned,
  SessionEventType.SubagentMessage,
  SessionEventType.SubagentStopped,
]);

// hook lifecycle 没有持久 message 形态，只能从内存侧恢复，再重挂到 hydration turn。
const HOOK_LIFECYCLE_EVENT_TYPES = new Set<string>([
  SessionEventType.HookRunStarted,
  SessionEventType.HookRunProgress,
  SessionEventType.HookRunCompleted,
  SessionEventType.HookRunFailed,
  SessionEventType.HookRunBlocked,
]);

/**
 * 扫描 hook lifecycle 的 runtime turn 归属：
 * 带 turnId 的终态直接解析；SessionStart 等到后续真实（非 model-only）TurnStarted 归位。
 * 只做事件内推导，不读库；返回 invocationId → runtime turnId。
 */
// [并发] 只做事件内推导不读库，结果对同一事件数组稳定可复现
// [失败路径] 缺 hookInvocationId 的 payload 直接跳过，不制造伪身份
// [权衡] model-only 维护轮不承接 SessionStart，否则摘要会挂到 compact 轮
// [事务] SessionStart 等到后续真实 TurnStarted 才归位，保持事件顺序语义
function hookInvocationTurnIds(events: readonly SessionEvent[]): Map<string, string> {
  const resolved = new Map<string, string>();
  const pending = new Set<string>();
  for (const event of events) {
    if (HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      const invocationId = stringField(event.payload, "hookInvocationId");
      if (!invocationId) continue;
      const eventName = stringField(event.payload, "hookEventName");
      if (eventName === "SessionStart") {
        // startup SessionStart 可能已经携带尚未映射的 runtime turnId；只有后续真实
        // TurnStarted 才能给出 durable product turn。async terminal 若已解析则沿用。
        if (!resolved.has(invocationId)) pending.add(invocationId);
        continue;
      }
      if (event.turnId) {
        resolved.set(invocationId, String(event.turnId));
        pending.delete(invocationId);
      } else if (!resolved.has(invocationId)) {
        pending.add(invocationId);
      }
      continue;
    }
    if (event.type !== SessionEventType.TurnStarted || !event.turnId || pending.size === 0) {
      continue;
    }
    // model-only 维护 turn（manual /compact、goal continuation）没有资格承载
    // SessionStart 摘要；resume SessionStart 必须等下一条 user-visible 真实 turn 归位。
    if (stringField(event.payload, "inputVisibility") === "model-only") continue;
    // resume SessionStart 在 Runtime 中先于下一条真实 TurnStarted；cold merge 必须沿
    // 同一事件顺序建立归属，不能把它追加到历史末尾或由 Renderer 猜最近一轮。
    for (const invocationId of pending) resolved.set(invocationId, String(event.turnId));
    pending.clear();
  }
  return resolved;
}

/** 按 code 聚合诊断；同 code 同类型累加，不覆盖先前计数。 */
function recordDiagnostic(
  diagnostics: Map<ColdEventMergeDiagnostic["code"], ColdEventMergeDiagnostic>,
  code: ColdEventMergeDiagnostic["code"],
  event: SessionEvent,
): void {
  const existing = diagnostics.get(code);
  if (existing) {
    existing.count += 1;
    existing.eventTypes[event.type] = (existing.eventTypes[event.type] ?? 0) + 1;
    return;
  }
  diagnostics.set(code, {
    code,
    count: 1,
    eventTypes: { [event.type]: 1 },
  });
}

/** 仅接受非空字符串；空串视为缺席，不制造伪身份。 */
function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 过滤空串/非字符串；畸形 payload 返回空数组，绝不抛。 */
function stringArrayField(payload: unknown, key: string): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

/**
 * 判定哪些内存 turn 仍应作为权威补充（未完成，或 transcript 没有对应 starter）。
 *
 * 没有终态事件的 turn 一定是未完成，必须保留；
 * 已终态但没有持久 messageId/anchor 的 legacy turn 无法证明已落盘，也保留；
 * 只有能对应到持久 starter 的 turn 才允许被 transcript 覆盖。
 */
// [事务] 无终态的 turn 一定是未完成，整体保留为内存权威
// [失败路径] 有终态但无持久 messageId 与 anchor 的 legacy turn 无法证明落盘，也要保留
// [权衡] 只有能对应到持久 starter 的 turn 才允许被 transcript 覆盖
// [并发] 判定只看持久 ID 集合，不依赖消息先后或时间戳
function memoryAuthorityTurnIds(
  events: readonly SessionEvent[],
  messages: readonly MessageWithParts[],
): { ambiguousLegacyStarts: SessionEvent[]; turnIds: Set<string> } {
  const started = new Map<string, SessionEvent>();
  const terminal = new Set<string>();
  for (const event of events) {
    const turnId = event.turnId ? String(event.turnId) : null;
    if (!turnId) continue;
    if (event.type === SessionEventType.TurnStarted) started.set(turnId, event);
    if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
      terminal.add(turnId);
    }
  }

  const persistedMessageIds = new Set(messages.map((message) => String(message.info.id)));
  const persistedTurnIds = new Set(
    messages.flatMap((message) =>
      message.info.anchor?.turnId ? [String(message.info.anchor.turnId)] : [],
    ),
  );
  const authority = new Set<string>();
  const ambiguousLegacyStarts: SessionEvent[] = [];
  for (const [turnId, start] of started) {
    if (!terminal.has(turnId)) {
      authority.add(turnId);
      continue;
    }
    const messageId = stringField(start.payload, "messageId");
    const hasDurableStarter =
      (messageId !== null && persistedMessageIds.has(messageId)) || persistedTurnIds.has(turnId);
    if (!hasDurableStarter) {
      authority.add(turnId);
      if (messageId === null) ambiguousLegacyStarts.push(start);
    }
  }
  return { ambiguousLegacyStarts, turnIds: authority };
}

/**
 * 保留 resumed 型 subagent lifecycle：它们不是 transcript 能重建的 spawn/stop，
 * 而是重连后仍在运行的 child 事实；丢掉会让侧栏 row 与 Stop 控制消失。
 */
function resumedSubagentLifecycleEventIndexes(events: readonly SessionEvent[]): Set<number> {
  const keep = new Set<number>();
  const resumedAgentIds = new Set<string>();
  events.forEach((event, index) => {
    const agentId = stringField(event.payload, "agentId");
    if (!agentId) return;
    if (event.type === SessionEventType.SubagentSpawned) {
      const payload = event.payload as Record<string, unknown>;
      if (payload.resumed === true) {
        resumedAgentIds.add(agentId);
        keep.add(index);
      }
      return;
    }
    if (event.type === SessionEventType.SubagentStopped && resumedAgentIds.has(agentId)) {
      keep.add(index);
    }
  });
  return keep;
}

/**
 * 选出仍需冷重放的 queue 状态事件，其余 settled 生命周期按重复抑制。
 *
 * pendingInputId 直到 drained/discarded/promoted 才算 settled；未 settled 的 id
 * 需要保留自最近一次 admission 起的完整 queued 生命周期，让 reducer 原地合并字段。
 * reorder/autoDrain/followupMode 只保留最后一条全局状态。
 */
// [事务] pendingInputId 直到 drained/discarded/promoted 才算 settled
// [失败路径] 未 settled 的 id 若丢掉首条 queued 事件，reducer 会缺 intent 与附件
// [权衡] reorder/autoDrain/followupMode 属全局策略，只保留最后一条即可
// [资源] 返回索引集合而非事件副本，保留原始 event 身份，避免额外深拷贝
function queueStateEventIndexes(events: readonly SessionEvent[]): Set<number> {
  const queuedLifecycleById = new Map<string, number[]>();
  const latestDispatchById = new Map<string, number>();
  const latestDeliveryChangeById = new Map<string, number>();
  const pendingIds = new Set<string>();
  let latestReorder: number | null = null;
  let latestAutoDrain: number | null = null;
  let latestFollowupMode: number | null = null;

  events.forEach((event, index) => {
    if (event.type === SessionEventType.TurnSteerQueued) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) {
        pendingIds.add(id);
        const lifecycle = queuedLifecycleById.get(id) ?? [];
        lifecycle.push(index);
        queuedLifecycleById.set(id, lifecycle);
      }
      return;
    }
    if (event.type === SessionEventType.TurnSteerDispatchChanged) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) latestDispatchById.set(id, index);
      return;
    }
    if (event.type === SessionEventType.TurnSteerDeliveryChanged) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) latestDeliveryChangeById.set(id, index);
      return;
    }
    if (event.type === SessionEventType.TurnSteerDrained) {
      for (const id of stringArrayField(event.payload, "pendingInputIds")) {
        pendingIds.delete(id);
        queuedLifecycleById.delete(id);
        latestDispatchById.delete(id);
        latestDeliveryChangeById.delete(id);
      }
      return;
    }
    if (event.type === SessionEventType.TurnSteerDiscarded) {
      for (const id of stringArrayField(event.payload, "pendingInputIds")) {
        pendingIds.delete(id);
        queuedLifecycleById.delete(id);
        latestDispatchById.delete(id);
        latestDeliveryChangeById.delete(id);
      }
      return;
    }
    if (event.type === SessionEventType.SessionInputPromoted) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) {
        pendingIds.delete(id);
        queuedLifecycleById.delete(id);
        latestDispatchById.delete(id);
        latestDeliveryChangeById.delete(id);
      }
      return;
    }
    if (event.type === SessionEventType.TurnSteerReordered) latestReorder = index;
    if (event.type === SessionEventType.QueueAutoDrainChanged) latestAutoDrain = index;
    if (event.type === SessionEventType.FollowupModeChanged) latestFollowupMode = index;
  });

  const keep = new Set<number>();
  for (const id of pendingIds) {
    const queuedLifecycle = queuedLifecycleById.get(id) ?? [];
    const dispatch = latestDispatchById.get(id);
    const deliveryChange = latestDeliveryChangeById.get(id);
    // editQueueItem 在旧事件里可能只重发新 text，完整 intent/附件/来源
    // 仍只在首次 queued 事件。从空投影 cold replay 时必须保留该 id
    // 自最近一次 admission 起的全部 queued 生命周期，让 reducer 原地合并字段。
    for (const queued of queuedLifecycle) keep.add(queued);
    const latestQueued = queuedLifecycle.at(-1) ?? -1;
    if (dispatch !== undefined && dispatch > latestQueued) keep.add(dispatch);
    if (deliveryChange !== undefined && deliveryChange > latestQueued) keep.add(deliveryChange);
  }
  if (latestReorder !== null && pendingIds.size > 0) keep.add(latestReorder);
  if (latestAutoDrain !== null) keep.add(latestAutoDrain);
  if (latestFollowupMode !== null) keep.add(latestFollowupMode);
  return keep;
}

/**
 * 选出需要随未完成 turn 一起恢复的 ModelSelected 事件。
 * 只有权威 turn（未被 transcript 覆盖）或完全没有 transcript 时才保留，
 * 避免重复的 setup 事件覆盖 hydrate 生成的模型边界。
 */
function setupModelEventIndexes(
  events: readonly SessionEvent[],
  authorityTurnIds: ReadonlySet<string>,
  messages: readonly MessageWithParts[],
): Set<number> {
  const keep = new Set<number>();
  let latestModelSelected: number | null = null;
  events.forEach((event, index) => {
    if (event.type === SessionEventType.ModelSelected) latestModelSelected = index;
    if (
      event.type === SessionEventType.TurnStarted &&
      event.turnId &&
      authorityTurnIds.has(String(event.turnId)) &&
      latestModelSelected !== null
    ) {
      keep.add(latestModelSelected);
    }
  });
  if (messages.length === 0 && latestModelSelected !== null) keep.add(latestModelSelected);
  return keep;
}

interface DurableBoundaryKeys {
  compact: Set<string>;
  fork: Set<string>;
  goal: Set<string>;
}

/**
 * goal verify 的稳定身份：targetId + goalIteration 优先，legacy 退回 verificationId。
 * 该 key 用于跨 timeline part / session_entry / 内存事件去重。
 */
function goalKey(payload: unknown): string | null {
  const targetId = stringField(payload, "targetId");
  const verificationId = stringField(payload, "verificationId");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const goalIteration = (payload as Record<string, unknown>).goalIteration;
  if (targetId && typeof goalIteration === "number") return `${targetId}_${goalIteration}`;
  return verificationId;
}

/**
 * 汇总 durable transcript 中已存在的 boundary 身份（compact/fork/goal）。
 * 内存中的同名 boundary 若已有 durable 副本，则被抑制；这是"durable 胜出"的判据。
 */
function durableBoundaryKeys(
  messages: readonly MessageWithParts[],
  goalEntries: readonly HydratedGoalVerificationEntry[],
): DurableBoundaryKeys {
  const compact = new Set<string>();
  const fork = new Set<string>();
  const goal = new Set<string>();
  for (const entry of goalEntries) {
    const key = goalKey(entry.payload);
    if (key) goal.add(key);
  }
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "timeline") {
        if (part.timelineType === "goal_verification") {
          const key = goalKey(part);
          if (key) goal.add(key);
        } else if (part.timelineType === "context_compaction") {
          compact.add(String(part.operationId));
        } else if (part.timelineType === "session_fork") {
          fork.add(`${String(part.parentSessionId)}\u0000${String(part.targetMessageId)}`);
        }
        continue;
      }
      if (part.type === "compaction") {
        compact.add(String(part.operationId ?? part.boundaryId ?? `legacy-compact-${part.id}`));
      }
    }
  }
  return { compact, fork, goal };
}

/** 内存事件 → boundary 身份；非 boundary 事件返回 null，不参与去重。 */
function durableBoundaryKeyForEvent(
  event: SessionEvent,
): { key: string | null; kind: keyof DurableBoundaryKeys } | null {
  if (event.type === SessionEventType.TargetCompletionVerification) {
    return { kind: "goal", key: goalKey(event.payload) };
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    return { kind: "compact", key: stringField(event.payload, "operationId") };
  }
  if (event.type === SessionEventType.SessionForked) {
    const parent = stringField(event.payload, "originalSessionId");
    const target = stringField(event.payload, "targetMessageId");
    return { kind: "fork", key: parent && target ? `${parent}\u0000${target}` : null };
  }
  return null;
}

/** 收集事件 payload 中所有可持久寻址的 messageId，用于建立 message→turn 映射。 */
function eventMessageIds(event: SessionEvent): string[] {
  const ids = [
    stringField(event.payload, "messageId"),
    stringField(event.payload, "assistantMessageId"),
  ].filter((id): id is string => id !== null);
  ids.push(...stringArrayField(event.payload, "injectedMessageIds"));
  if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    const drainedInputs = (event.payload as Record<string, unknown>).drainedInputs;
    if (Array.isArray(drainedInputs)) {
      for (const input of drainedInputs) {
        const messageId = stringField(input, "messageId");
        if (messageId) ids.push(messageId);
      }
    }
  }
  return ids;
}

/**
 * 只靠持久实体 ID 建立 transcript message → hydration turn 映射。
 * assistant 没有 text part 时可能不直接产 assistantMessageId，因此再用持久的
 * parentID / anchor.turnId 传播；禁止用文本或时间邻近猜测轮归属。
 */
// [事务] 先按事件 payload 的持久 messageId 建种子，再沿 parentID 与 anchor 传播
// [并发] 传播是单调增的定点迭代，changed 为假即收敛，不会死循环
// [失败路径] 禁止用文本或时间邻近猜轮归属，宁可留空也不挂错
// [权衡] 只依赖持久实体 ID，assistant 无 text part 时仍可经父消息归位
// [资源] 结果 Map 只随消息数量增长，冷恢复一次性使用后即可被回收
function durableTurnByMessageId(
  messages: readonly MessageWithParts[],
  events: readonly SessionEvent[],
): Map<string, string> {
  const turnByMessageId = new Map<string, string>();
  for (const event of events) {
    if (!event.turnId) continue;
    for (const messageId of eventMessageIds(event)) {
      turnByMessageId.set(messageId, String(event.turnId));
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const turnByRuntimeAnchor = new Map<string, string>();
    for (const message of messages) {
      const turnId = turnByMessageId.get(String(message.info.id));
      const runtimeAnchor = message.info.anchor?.turnId;
      if (turnId && runtimeAnchor) turnByRuntimeAnchor.set(String(runtimeAnchor), turnId);
    }
    for (const message of messages) {
      const messageId = String(message.info.id);
      if (turnByMessageId.has(messageId)) continue;
      const parentTurn =
        message.info.role === "assistant" && message.info.parentID
          ? turnByMessageId.get(String(message.info.parentID))
          : undefined;
      const anchorTurn = message.info.anchor?.turnId
        ? turnByRuntimeAnchor.get(String(message.info.anchor.turnId))
        : undefined;
      const turnId = parentTurn ?? anchorTurn;
      if (!turnId) continue;
      turnByMessageId.set(messageId, turnId);
      changed = true;
    }
  }
  return turnByMessageId;
}

/**
 * Hook lifecycle 只携带 runtime turnId，没有持久 messageId；cold transcript 则会
 * 重新生成 hydrate-turn-*。这里只使用持久 message anchor 建立无歧义身份映射，
 * 禁止按文本或时间邻近猜测。若同一 runtime anchor 指向多个 hydration turn，宁可
 * 保留原事件等待显式恢复边界，也不能把 Hook 错挂到另一轮。
 */
function durableTurnByRuntimeAnchor(
  messages: readonly MessageWithParts[],
  turnByMessageId: ReadonlyMap<string, string>,
): Map<string, string> {
  const turnByRuntimeAnchor = new Map<string, string>();
  const ambiguousRuntimeAnchors = new Set<string>();
  for (const message of messages) {
    const runtimeAnchor = message.info.anchor?.turnId;
    const durableTurnId = turnByMessageId.get(String(message.info.id));
    if (!runtimeAnchor || !durableTurnId) continue;
    const runtimeTurnId = String(runtimeAnchor);
    if (ambiguousRuntimeAnchors.has(runtimeTurnId)) continue;
    const existing = turnByRuntimeAnchor.get(runtimeTurnId);
    if (existing && existing !== durableTurnId) {
      turnByRuntimeAnchor.delete(runtimeTurnId);
      ambiguousRuntimeAnchors.add(runtimeTurnId);
      continue;
    }
    turnByRuntimeAnchor.set(runtimeTurnId, durableTurnId);
  }
  return turnByRuntimeAnchor;
}

/**
 * queue drain 可在同一 runtime turn 内切出多个 product turn；Hook 仍只携带
 * runtime turnId，因此必须按事件顺序跟随持久 message boundary。首次 lifecycle
 * 一旦解析成功就冻结 invocation 归属，避免后台 terminal 跨 boundary 后改挂。
 */
function durableHookTurnByInvocationId(
  events: readonly SessionEvent[],
  turnByMessageId: ReadonlyMap<string, string>,
): Map<string, string> {
  const currentTurnByRuntimeId = new Map<string, string>();
  const runtimeTurnByPendingInputId = new Map<string, string>();
  const runtimeTurnByInvocationId = hookInvocationTurnIds(events);
  const durableTurnByInvocationId = new Map<string, string>();

  const advance = (runtimeTurnId: string | null, messageId: string | null): void => {
    if (!runtimeTurnId || !messageId) return;
    const durableTurnId = turnByMessageId.get(messageId);
    if (durableTurnId) currentTurnByRuntimeId.set(runtimeTurnId, durableTurnId);
  };

  for (const event of events) {
    if (event.type === SessionEventType.TurnStarted) {
      advance(event.turnId ? String(event.turnId) : null, stringField(event.payload, "messageId"));
    } else if (event.type === SessionEventType.TurnSteerDrained) {
      const runtimeTurnId =
        stringField(event.payload, "targetTurnId") ?? (event.turnId ? String(event.turnId) : null);
      const drainedInputs =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>).drainedInputs
          : undefined;
      if (runtimeTurnId && Array.isArray(drainedInputs)) {
        for (const input of drainedInputs) {
          const pendingInputId = stringField(input, "pendingInputId");
          if (pendingInputId) runtimeTurnByPendingInputId.set(pendingInputId, runtimeTurnId);
          if (stringField(input, "delivery") !== "guide") {
            advance(runtimeTurnId, stringField(input, "messageId"));
          }
        }
      }
    } else if (event.type === SessionEventType.SessionInputPromoted) {
      const pendingInputId = stringField(event.payload, "pendingInputId");
      const runtimeTurnId = event.turnId
        ? String(event.turnId)
        : pendingInputId
          ? (runtimeTurnByPendingInputId.get(pendingInputId) ?? null)
          : null;
      advance(runtimeTurnId, stringField(event.payload, "messageId"));
    }

    if (!HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) continue;
    const invocationId = stringField(event.payload, "hookInvocationId");
    if (!invocationId || durableTurnByInvocationId.has(invocationId)) continue;
    const runtimeTurnId =
      runtimeTurnByInvocationId.get(invocationId) ??
      (event.turnId ? String(event.turnId) : undefined);
    const durableTurnId = runtimeTurnId ? currentTurnByRuntimeId.get(runtimeTurnId) : undefined;
    if (durableTurnId) durableTurnByInvocationId.set(invocationId, durableTurnId);
  }
  return durableTurnByInvocationId;
}

function boundaryAnchorMessageId(event: SessionEvent): string | null {
  if (event.type === SessionEventType.TargetCompletionVerification) {
    return (
      stringField(event.payload, "anchorAssistantMessageId") ??
      stringField(event.payload, "anchorMessageId")
    );
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    return stringField(event.payload, "anchorMessageId");
  }
  if (event.type === SessionEventType.SessionForked) {
    return (
      stringField(event.payload, "targetMessageId") ?? stringField(event.payload, "anchorMessageId")
    );
  }
  return null;
}

/**
 * 把 prefix（SessionStart）插到对应 hydration turn 首事件之前，
 * tail（compact/fork/goal boundary）插到该轮末事件之后，其余追加到全局尾部。
 * 这样即使内存事件晚到，其物理位置也与 durable 轮边界一致。
 */
// [事务] prefix 插到该轮首事件之前，tail 插到末事件之后，轮内相对顺序不变
// [失败路径] 目标 turn 不在 durable 序列时跳过插入，不让事件渗到错误的轮
// [权衡] 其余事件统一追加全局尾部，物理位置服从 durable 轮边界
// [事务] 同一插入点同时存在 prefix 与 tail 时，先 before 后 after，顺序确定
function insertAtDurableTurnBoundaries(input: {
  durableEvents: readonly SessionEvent[];
  trailingEvents: readonly SessionEvent[];
  turnPrefixEvents: ReadonlyMap<string, readonly SessionEvent[]>;
  turnTailEvents: ReadonlyMap<string, readonly SessionEvent[]>;
}): SessionEvent[] {
  const firstIndexByTurnId = new Map<string, number>();
  const tailIndexByTurnId = new Map<string, number>();
  input.durableEvents.forEach((event, index) => {
    if (!event.turnId) return;
    const turnId = String(event.turnId);
    if (!firstIndexByTurnId.has(turnId)) firstIndexByTurnId.set(turnId, index);
    tailIndexByTurnId.set(turnId, index);
  });
  const beforeIndex = new Map<number, SessionEvent[]>();
  for (const [turnId, events] of input.turnPrefixEvents) {
    const firstIndex = firstIndexByTurnId.get(turnId);
    if (firstIndex === undefined) continue;
    beforeIndex.set(firstIndex, [...(beforeIndex.get(firstIndex) ?? []), ...events]);
  }
  const afterIndex = new Map<number, SessionEvent[]>();
  for (const [turnId, events] of input.turnTailEvents) {
    const tailIndex = tailIndexByTurnId.get(turnId);
    if (tailIndex === undefined) continue;
    afterIndex.set(tailIndex, [...(afterIndex.get(tailIndex) ?? []), ...events]);
  }

  const merged: SessionEvent[] = [];
  input.durableEvents.forEach((event, index) => {
    merged.push(...(beforeIndex.get(index) ?? []));
    merged.push(event);
    merged.push(...(afterIndex.get(index) ?? []));
  });
  merged.push(...input.trailingEvents);
  return merged;
}

/** 合并后重排 sequenceNumber（从 1 连续递增），不复制旧值，保证重放全序唯一。 */
function resequence(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((event, index) => ({ ...event, sequenceNumber: index + 1 }));
}

/**
 * 冷恢复三源合并入口。
 *
 * 顺序：先裁掉被内存权威 turn 覆盖的 message/goal entry，再合成 durable 事件；
 * 若存在持久 session_target，则在 SessionCreated 之后插入权威 TargetChanged；
 * 最后按分类遍历内存事件（hook/boundary/queue/model/memory-only/unclassified），
 * 分别抑制、改写 turnId 插入或追加，并统一 resequence。
 * 冲突口径：durable transcript 与 session_target 胜出；其余无法判定的旧事实
 * 保留并记诊断，绝不静默丢。
 * 副作用：只读入参，返回新事件对象；不写库、不修改原事件。
 */
/**
 * 冷恢复三源合并：message/part 是已完成正文权威；session_entry 只补 legacy goal；
 * 内存事件只补未完成 turn 与没有 transcript 形态的当前状态。
 */
export function mergeColdConversationEvents(input: MergeInput): ColdEventMergeResult {
  const diagnostics = new Map<ColdEventMergeDiagnostic["code"], ColdEventMergeDiagnostic>();
  const hasPersistedTargetAuthority = Object.prototype.hasOwnProperty.call(input, "target");
  const authorityTurns = memoryAuthorityTurnIds(input.memoryEvents, input.messages);
  const authorityTurnIds = authorityTurns.turnIds;
  for (const event of authorityTurns.ambiguousLegacyStarts) {
    // 旧 TurnStarted 既没有 messageId，transcript 也没有同 turn anchor 时，
    // 禁止用 input 文本/时间猜测实体同一性。相同文本可以是两次真实提交；
    // 宁可保留该内存 turn 并显式诊断，也不能把未持久 in-flight 误当重复删掉。
    recordDiagnostic(diagnostics, "cold_merge.ambiguous_legacy_turn_preserved", event);
  }
  const durableMessages = input.messages.filter(
    (message) =>
      !message.info.anchor?.turnId || !authorityTurnIds.has(String(message.info.anchor.turnId)),
  );
  const durableGoalEntries = (input.goalVerificationEntries ?? []).filter(
    (entry) => !entry.payload.anchorTurnId || !authorityTurnIds.has(entry.payload.anchorTurnId),
  );
  const transcriptEvents = synthesizeEventsFromMessages(durableMessages, {
    sessionId: input.sessionId,
    contextWindow: input.contextWindow,
    fileChangeSummariesByMessageId: input.fileChangeSummariesByMessageId,
    goalVerificationEntries: durableGoalEntries,
  });
  const durableEvents = input.target
    ? [
        ...transcriptEvents.slice(0, 1),
        {
          id: "hydrate-goal-state" as SessionEvent["id"],
          sessionId: input.sessionId as SessionEvent["sessionId"],
          type: SessionEventType.TargetChanged,
          timestamp: new Date(input.target.time.updated),
          traceId: "trace-hydration" as SessionEvent["traceId"],
          sequenceNumber: 0,
          payload: { action: "set", source: "runtime", target: input.target },
        },
        ...transcriptEvents.slice(1),
      ]
    : transcriptEvents;
  const durableTurnIds = new Set(
    durableEvents.flatMap((event) => (event.turnId ? [String(event.turnId)] : [])),
  );
  const queueIndexes = queueStateEventIndexes(input.memoryEvents);
  const resumedSubagentIndexes = resumedSubagentLifecycleEventIndexes(input.memoryEvents);
  const modelSetupIndexes = setupModelEventIndexes(
    input.memoryEvents,
    authorityTurnIds,
    input.messages,
  );
  const supplements: SessionEvent[] = [];
  const prefixEventsByTurnId = new Map<string, SessionEvent[]>();
  const boundaryEventsByTurnId = new Map<string, SessionEvent[]>();
  const boundaryKeys = durableBoundaryKeys(durableMessages, durableGoalEntries);
  const turnByMessageId = durableTurnByMessageId(durableMessages, durableEvents);
  const turnByRuntimeAnchor = durableTurnByRuntimeAnchor(durableMessages, turnByMessageId);
  const hookTurnIdByInvocationId = hookInvocationTurnIds(input.memoryEvents);
  const durableHookTurnByInvocation = durableHookTurnByInvocationId(
    input.memoryEvents,
    turnByMessageId,
  );

  input.memoryEvents.forEach((event, index) => {
    if (HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      const invocationId = stringField(event.payload, "hookInvocationId");
      // invocation 扫描会把 startup/resume SessionStart 的临时 runtime turn 修正为
      // 后续真实 TurnStarted；因此它必须优先于单条事件上尚未建立 product mapping
      // 的 turnId。普通 prompt/tool invocation 得到的仍是同一个 runtime turn。
      const resolvedTurnId = invocationId
        ? (hookTurnIdByInvocationId.get(invocationId) ??
          (event.turnId ? String(event.turnId) : undefined))
        : event.turnId
          ? String(event.turnId)
          : undefined;
      const durableTurnId =
        (invocationId ? durableHookTurnByInvocation.get(invocationId) : undefined) ??
        (resolvedTurnId
          ? durableTurnIds.has(resolvedTurnId)
            ? resolvedTurnId
            : turnByRuntimeAnchor.get(resolvedTurnId)
          : undefined);
      if (durableTurnId) {
        const eventName = stringField(event.payload, "hookEventName");
        const target = eventName === "SessionStart" ? prefixEventsByTurnId : boundaryEventsByTurnId;
        const events = target.get(durableTurnId) ?? [];
        // memory Hook 保留 runtime turnId，而 transcript synthesis 使用
        // hydrate-turn-*；直接比较两者会让 completed Hook 变成 orphan row，
        // SessionStart 也会残留 pending。先改写到 hydration turn 后，既有
        // ProductProjection TurnStarted 映射会继续收敛到稳定 message product turn。
        events.push({ ...event, turnId: durableTurnId as TurnId });
        target.set(durableTurnId, events);
      } else {
        // 只打开历史而尚无下一真实 turn 的 resume SessionStart 继续留作 projection
        // pending，不为它制造 synthetic turn；后续 live TurnStarted 会完成归位。
        supplements.push(event);
      }
      return;
    }
    const boundary = durableBoundaryKeyForEvent(event);
    if (boundary) {
      // [事务] boundary key 已在 durable 副本出现时抑制内存重复并计入 durable 诊断
      // [失败路径] 按 key 去重而非按类型去重，避免把两次真实压缩误判为一次
      // [权衡] 无 key 的遗留 boundary 无法比对，只能保留并显式记降级
      // [事务] 命中即提前返回，不再进入后续 queue、live 与 memory 分类分支
      if (boundary.key && boundaryKeys[boundary.kind].has(boundary.key)) {
        recordDiagnostic(diagnostics, "cold_merge.durable_event_suppressed", event);
        return;
      }
      // durable boundary 写 part/session_entry 失败时，内存事件是唯一剩余事实。
      // boundary 的持久实体 anchor 优先于事件到达时所在的 active runtime turn；
      // 否则迟到 boundary 会被误留在 unfinished turn 末尾。
      const anchorMessageId = boundaryAnchorMessageId(event);
      const durableTurnId = anchorMessageId ? turnByMessageId.get(anchorMessageId) : undefined;
      if (durableTurnId) {
        const events = boundaryEventsByTurnId.get(durableTurnId) ?? [];
        // durableEvents + supplements 不能直接拼接：即使 boundary
        // 带持久 message anchor，也会被挪到整个 transcript 末尾。这里同时改写为
        // hydration product turn 并插入该轮 tail，身份和物理顺序一次对齐。
        events.push({ ...event, turnId: durableTurnId as TurnId });
        boundaryEventsByTurnId.set(durableTurnId, events);
      } else {
        // legacy 无显式/可解析 anchor：按冻结 fallback 放最后一个已知宿主之后；
        // memory_boundary_preserved diagnostic 让这次降级保持可观测。
        supplements.push(event);
      }
      recordDiagnostic(diagnostics, "cold_merge.memory_boundary_preserved", event);
      return;
    }
    const turnId = event.turnId ? String(event.turnId) : null;
    if (turnId && authorityTurnIds.has(turnId)) {
      supplements.push(event);
      return;
    }
    if (queueIndexes.has(index) || modelSetupIndexes.has(index)) {
      supplements.push(event);
      return;
    }
    if (
      event.type === SessionEventType.TurnSteerQueued ||
      event.type === SessionEventType.TurnSteerDeliveryChanged ||
      event.type === SessionEventType.TurnSteerDispatchChanged ||
      event.type === SessionEventType.TurnSteerDrained ||
      event.type === SessionEventType.TurnSteerDiscarded ||
      event.type === SessionEventType.SessionInputPromoted ||
      event.type === SessionEventType.TurnSteerReordered ||
      event.type === SessionEventType.QueueAutoDrainChanged ||
      event.type === SessionEventType.FollowupModeChanged
    ) {
      recordDiagnostic(diagnostics, "cold_merge.settled_queue_event_suppressed", event);
      return;
    }
    // [事务] session_target 已是持久权威，内存 TargetChanged 一律抑制，显式 null 同样抑制
    // [失败路径] 不压会让旧内存 goal 覆盖冷恢复终态，用户回到过期目标
    // [权衡] 判据是字段存在而非值为 null，避免未读取被当作已清空
    // [失败路径] target 属缺席却误判为有权威，内存里更新的 goal 会被永久吞掉
    if (event.type === SessionEventType.TargetChanged && hasPersistedTargetAuthority) {
      // session_target 已是持久权威，旧 merge 却把内存 TargetChanged 当
      // ephemeral 尾事件追加，冷恢复终态会被旧 goal 覆盖；显式 null 也必须压掉旧事件。
      recordDiagnostic(diagnostics, "cold_merge.durable_event_suppressed", event);
      return;
    }
    if (LIVE_ONLY_EVENT_TYPES.has(event.type)) {
      // 插件 UI 资源通知只对当时活着的沙箱实例有意义，冷恢复一律丢弃。
      recordDiagnostic(diagnostics, "cold_merge.non_product_event_suppressed", event);
      return;
    }
    if (MEMORY_ONLY_EVENT_TYPES.has(event.type)) {
      supplements.push(event);
      return;
    }
    if (resumedSubagentIndexes.has(index)) {
      // SendMessage tool transcript 不会合成它恢复的 child lifecycle；若按普通
      // transcript-derived Subagent* 去重，replayable 重连会丢失正在运行的 row 和 Stop 控制。
      supplements.push(event);
      return;
    }
    if (TRANSCRIPT_DERIVED_EVENT_TYPES.has(event.type)) {
      recordDiagnostic(diagnostics, "cold_merge.durable_event_suppressed", event);
      return;
    }
    // ProductProjection 当前可能忽略这类事件，但读取层不能把未知老事实静默删掉；
    // 保留原事件并聚合诊断，后续 normalizer 扩词表时仍有输入可追溯。
    supplements.push(event);
    recordDiagnostic(diagnostics, "cold_merge.unclassified_event_preserved", event);
  });

  return {
    diagnostics: [...diagnostics.values()],
    events: resequence(
      insertAtDurableTurnBoundaries({
        durableEvents,
        trailingEvents: supplements,
        turnPrefixEvents: prefixEventsByTurnId,
        turnTailEvents: boundaryEventsByTurnId,
      }),
    ),
    usedDurableTranscript:
      durableMessages.length > 0 || durableGoalEntries.length > 0 || hasPersistedTargetAuthority,
  };
}
