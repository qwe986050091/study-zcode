//
// 职责边界：本文件是 runtime 的事件出口层，只做四件事 —— 给事件绑定身份、落库后发布、
// 按事件类型补写 durable session entry、把 session 首次持久化做成幂等单飞。
// 它不负责序号分配（eventStore 补号）、不负责 sink 的呈现、不负责 Turn 生命周期决策。
// 任何在这里「顺便」做业务推导的改动，都会让 live 与 replay 产生第二套事实。
// 因此本文件只允许做投影与持久化转发，衍生状态一律回上游或下沉到专用模块。
//
// 不变量表（违反任一条都会让事件流在 live / replay / snapshot 三处出现分叉）：
// INV-01 断言：appendEvent 只发布 eventStore.append 返回的 storedEvent —— 守住它的位置：notifyEventSinks 的入参必须来自 append 返回值 —— 改错故障：sink 收到 sequenceNumber=0 的事件，live 与 replay 顺序事实分叉。
// INV-02 断言：live sink 的 eventSeq 一律由 event store 补号后产生 —— 守住它的位置：createEvent 只绑定 sessionId/turnId/traceId，不自行编号 —— 改错故障：同一条消息在 UI 与恢复后得到两个序号，去重与游标同时失效。
// INV-03 断言：落库成功才通知 sink —— 守住它的位置：append 与 notifyEventSinks 的先后顺序不可交换 —— 改错故障：sink 先看到事件而落库失败，客户端持有永不复现的幽灵消息。
// INV-04 断言：热路径事件只聚合计数、不逐条打日志 —— 守住它的位置：SUMMARY_SESSION_EVENT_TYPES 的 membership 判定 —— 改错故障：token 级事件与消息流同频刷盘，daily log 被放大成索引副本。
// INV-05 断言：聚合条目按 turnId 加 type 归并，阈值到达即冲刷 —— 守住它的位置：recordSessionEventAppendAggregate 的 existing 分支 —— 改错故障：聚合 Map 无界增长，长会话内存随事件数线性膨胀。
// INV-06 断言：聚合冲刷后必须从 Map 删除，并携带首末 seq 区间 —— 守住它的位置：flushSessionEventAppendAggregate 的 delete 与 payload 字段 —— 改错故障：同一区间被重复上报，诊断日志出现交叠窗口。
// INV-07 断言：低频事件到达时先冲刷已有聚合，再按单条记录 —— 守住它的位置：flushSessionEventAppendAggregates 的调用点 —— 改错故障：聚合缓冲里残留的事件永远等不到下一条同型事件，诊断丢尾。
// INV-08 断言：payload 体积测量失败按 0 计，不影响主流程 —— 守住它的位置：measureJsonBytes 的 catch —— 改错故障：循环引用 payload 直接把落库抛错，事件丢失。
// INV-09 断言：TurnComplete 与 TurnError 必须先写 lastOutcome 再返回 —— 守住它的位置：persistDurableSessionEvent 的首个终态分支 —— 改错故障：Host 冷启动把中断或失败的 Turn 推导成成功。
// INV-10 断言：终态 outcome 的映射是 error 到 interrupted 再到 completed 三分 —— 守住它的位置：lastOutcome 的三元表达式 —— 改错故障：用户取消被记成 completed，恢复后的会话状态与用户认知相反。
// INV-11 断言：每个事件分支写入后必须 return，不得继续下坠 —— 守住它的位置：persistDurableSessionEvent 各分支末尾 —— 改错故障：同一事件被多个分支重复持久化，entry 覆写成错误类型。
// INV-12 断言：session_input 账本只在事件汇记账，不在各发射点重复记账 —— 守住它的位置：TurnSteerQueued / DeliveryChanged / Discarded 三处集中分支 —— 改错故障：5 个以上发射点各自补账，漏一处就出现只存在于内存的 pending 输入。
// INV-13 断言：TurnSteerDiscarded 的 reason=promoted 必须原样返回、不改账本 —— 守住它的位置：payload.reason 判定之前的提前 return —— 改错故障：remove 与 promotion 之间崩溃则输入丢失，队列项既不在内存也不在账本。
// INV-14 断言：session_resumed 记 discarded，其余用户动作记 cancelled —— 守住它的位置：status 的三元映射 —— 改错故障：重启丢失的队列被误标为用户主动取消，审计口径失真。
// INV-15 断言：账本写入失败只告警、不向事件流抛错 —— 守住它的位置：三处 saveSessionInput 与 update 与 settle 的 catch —— 改错故障：一次账本抖动把整条 Turn 打挂，事件已经落库却无法继续。
// INV-16 断言：目标校验时间线的 messageId 与 partId 由 targetId 加迭代号稳定派生 —— 守住它的位置：targetCompletionVerificationTimelineKey —— 改错故障：同一目标每轮生成新 ID，恢复后出现重复分割线。
// INV-17 断言：已有时间线时复用其 created 与 started 时间 —— 守住它的位置：readExistingTimelineTiming 的返回值优先级 —— 改错故障：恢复后的分割线跳位，goal 分组的时间轴顺序错乱。
// INV-18 断言：单个 sink 抛错不得影响其他 sink —— 守住它的位置：notifyEventSinks 的 per-sink try/catch —— 改错故障：一个遥测 sink 异常导致 UI 收不到事件，界面停在运行中。
// INV-19 断言：session 持久化必须单飞，并发调用共享同一个 Promise —— 守住它的位置：pendingSessionPersistence 这个 WeakMap —— 改错故障：App sampling 与首轮并发各建一次 session，模型配置互相覆盖。
// INV-20 断言：sessionPersisted 只在全部持久化成功后才置位 —— 守住它的位置：persistSession 尾部的赋值 —— 改错故障：中途失败被标记成已持久化，后续调用直接跳过，会话永远缺记录。
//
import type { WorkspaceId } from "@zcode/contracts";
import { buildExecutionStateEntry, readRuntimeExecutionState } from "../execution-state.js";
import {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SessionEventType,
  createMessageId,
  createPartId,
  createSessionEvent,
  traceContextToLogContext,
} from "../deps.js";
import type {
  MessageId,
  PartId,
  SessionEvent,
  SessionId,
  TargetCompletionVerificationPayload,
  TraceContext,
  TurnInputIntentMetadata,
  UserInputAutoResolutionUpdatedPayload,
} from "../deps.js";
import { titleFromInput, slugify, projectIdFromDirectory } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildPersistedConversationInputIntent } from "./input-intent-persistence.js";
import { recordToolUsageFromEvent } from "./usage-observability.js";
import { persistSessionShellEnvironmentSnapshot } from "./session-shell-environment.js";
import { persistRuntimeModelSelection } from "./turn-model.js";
import { writeDynamicWorkflowActivationEntryIfActivated } from "./dynamic-workflow-activation.js";
import {
  persistWorkspaceCheckpointEntry,
  persistWorkspaceFileRewindEntry,
} from "./workspace-checkpoint-persistence.js";

// [权衡] 100 是「日志放大」与「诊断粒度」的折中点：
// 调小会把 summary 变成逐条日志，调大则单次冲刷要覆盖更长的 seq 区间。
// 这个数只影响日志，不参与事件语义，但不要按事件类型分设不同阈值。
const SESSION_EVENT_APPEND_SUMMARY_FLUSH_COUNT = 100;

// [契约] 这个集合定义「只做聚合、不打单条日志」的事件面。
// 只应包含与 token 流同频的类型，接入新的流式事件前先确认它是否真的逐帧产生。
// 把 TurnComplete 之类低频终态放进来的代价是：终态日志被延迟到下一次冲刷才可见。
const SUMMARY_SESSION_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.ModelStreaming,
  SessionEventType.ModelNetworkStatus,
  SessionEventType.StreamingToolLedgerUpdated,
  SessionEventType.ToolCallProgress,
]);

// 生产环境只记录会改变 Turn/Session 生命周期的低频事件；stream/progress 仍由
// 现有 debug 聚合日志覆盖，避免诊断日志和消息流同频刷盘。
// [权衡] 生产环境只保留会改变 Turn 与 Session 生命周期的事件走 info 双日志。
// stream 与 progress 由上面的聚合 summary 覆盖，不在这里重复登记。
// 两组集合必须互斥：同一类型同时属于两边，会得到 started、summary、completed 三重记录。
// 新增类型时先问它是否会改变生命周期，再决定进哪一个集合。
const LIFECYCLE_SESSION_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.SessionTitleUpdated,
  SessionEventType.TurnStarted,
  SessionEventType.ModelRequest,
  SessionEventType.ModelComplete,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
]);

// [契约] 聚合条目记录的是区间事实：首末事件 ID 与首末 seq 共同界定一个窗口。
// 只保留首末而不保留中间 ID 是有意取舍：中间明细可从 eventStore 反查，内存里不该再复制一份。
// payloadKinds 的计数只是诊断分布快照，不要把它当成事件类型的事实源。
interface SessionEventAppendAggregate {
  eventCount: number;
  eventType: SessionEventType;
  firstEventId: string;
  firstSessionEventSequenceNumber: number;
  lastEventId: string;
  lastSessionEventSequenceNumber: number;
  payloadBytes: number;
  payloadKinds: Record<string, number>;
}

// [资源] 聚合状态挂在 runtime 实例上而不是模块级 Map，实例被回收时聚合随之消失。
// 用 WeakMap 是因为聚合只是观测附属物，不能因为诊断而延长 runtime 生命周期。
// [并发] 同一 runtime 的多条 append 可能并发进入，Map 读写没有额外加锁，依赖单线程内判定与写入之间不 await 这一前提。
const sessionEventAppendAggregates = new WeakMap<
  AgentRuntimeInternal,
  Map<string, SessionEventAppendAggregate>
>();

/**
 * 创建一条 SessionEvent(尚未落库)。
 * sequenceNumber 由 eventStore 落库时补号;这里只绑定 sessionId/turnId/traceId,
 * 保证 live、replay、snapshot 共享同一套事件身份。
 */
export function createEvent(
  this: AgentRuntimeInternal,
  type: SessionEventType,
  payload: unknown,
  traceContext: TraceContext,
): SessionEvent {
  return createSessionEvent(type, this.sessionId, payload, {
    turnId: traceContext.turnId,
    traceId: traceContext.traceId,
  });
}

/**
 * 把事件写入 eventStore,再依次:
 *   1) 持久化 durable session event(用于 replay/恢复);
 *   2) 记录事件中的工具用量;
 *   3) 通知 live sinks(UI/遥测)。
 * 只有落库后的事件才会发给 sink,保证 eventSeq 在 live/replay/snapshot 三处一致。
 */
export async function appendEvent(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  // live sink 以前拿到的是 createSessionEvent 默认的 sequenceNumber=0，
  // 而 replay/read 路径拿到的是 eventStore 补号后的事件，导致同一 session 有两套顺序事实。
  // 这里只发布已落库事件，让 live、replay、snapshot 的 eventSeq 全部来自同一个 event store。
  // [契约] 这条判定只决定是否打 info 日志，不决定是否落库。
  // 落库对所有事件一视同仁，把日志开关和持久化分支混用会让高频事件被静默丢弃。
  // 改这里的唯一安全方向是往集合里增删类型，不要就地改成按 payload 判断。
  const shouldLogLifecycle = LIFECYCLE_SESSION_EVENT_TYPES.has(event.type);
  const startedAt = Date.now();
  if (shouldLogLifecycle) {
    this.logger?.info("Session event persistence started", {
      ...traceContextToLogContext(traceContext),
      event: "session.event.persistence.started",
      module: "core.runtime",
      sessionEventType: event.type,
      status: "started",
    });
  }

  let phase = "event_store.append";
  try {
    // [事务] append 是整条链路的唯一编号点，返回的 storedEvent 才是后续所有步骤的事实。
    // 不要用入参 event 继续往下传：它的 sequenceNumber 还是 0，sink 与 durable entry 会各拿一套顺序。
    // 此处失败必须直接冒泡，不能降级成「只通知 sink」，否则客户端会看到不存在于 store 的事件。
    const storedEvent = await this.eventStore.append(event);
    phase = "session_event.persist_durable";
    await persistDurableSessionEvent.call(this, storedEvent, traceContext);
    phase = "session_event.record_usage";
    await recordToolUsageFromEvent(this, storedEvent, traceContext);
    phase = "session_event.notify_sinks";
    // [契约] sink 只能在 durable entry 与用量记录都写完之后才被通知。
    // 顺序反了会出现「UI 已展示、恢复却缺失」的窗口，而 replay 以 store 为准，用户看到的内容会回退。
    // [失败路径] 单个 sink 的异常在 notifyEventSinks 内部被吞掉并记日志，不会让本条事件被判失败。
    await this.notifyEventSinks(storedEvent, traceContext);
    if (shouldLogLifecycle) {
      this.logger?.info("Session event persistence completed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        event: "session.event.persistence.completed",
        module: "core.runtime",
        sessionEventSequenceNumber: storedEvent.sequenceNumber,
        sessionEventType: storedEvent.type,
        status: "completed",
      });
    }
    if (recordSessionEventAppendAggregate.call(this, storedEvent, traceContext)) {
      return;
    }
    // [契约] 低频事件是天然的冲刷边界：说明当前 Turn 的阶段已经变化，残留聚合应就地结账。
    // 如果只记录当前事件而不先冲刷，上一段流式聚合会一直等到下一次同型事件才落日志。
    // 冲刷失败不能影响主流程，此处没有返回值也照常继续往下写 debug 日志。
    flushSessionEventAppendAggregates.call(this, traceContext, "low_frequency_event");
    this.logger?.debug("Session event appended", {
      ...traceContextToLogContext(traceContext),
      event: "event_store.appended",
      module: "core.runtime",
      sessionEventSequenceNumber: storedEvent.sequenceNumber,
      sessionEventType: storedEvent.type,
    });
  } catch (error) {
    if (shouldLogLifecycle) {
      this.logger?.warn("Session event persistence failed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session.event.persistence.failed",
        module: "core.runtime",
        phase,
        sessionEventType: event.type,
        status: "failed",
      });
    }
    // [失败路径] 这里必须重抛：appendEvent 的调用方要靠异常决定是否回滚本轮与是否向用户报错。
    // 如果只记 warn 并 return，Turn 会在「事件没落库」的状态下继续推进，后续恢复直接断链。
    // phase 变量记录的是最后一个正在执行的阶段，写日志时不要提前覆盖它。
    throw error;
  }
}

// [契约] 返回 true 表示本事件已被聚合吸收、调用方不要再写单条 debug 日志。
// 返回 false 只表示「不属于聚合面」，绝不表示失败，所以两个分支都不抛错。
// 把返回值改成 void 会让调用方无法区分已聚合与未匹配，从而给高频事件补上逐条日志。
function recordSessionEventAppendAggregate(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): boolean {
  if (!SUMMARY_SESSION_EVENT_TYPES.has(event.type)) {
    return false;
  }

  const aggregateKey = `${traceContext.turnId ?? "session"}:${event.type}`;
  const aggregateMap = getSessionEventAppendAggregateMap(this);
  const payloadKind = getPayloadKind(event.payload);
  const existing = aggregateMap.get(aggregateKey);
  // [契约] 已有聚合时原地累加，必须同时推进 lastEventId 与 lastSessionEventSequenceNumber。
  // 只更新计数不更新末位，会得到一个数量对、区间错的 summary，排查时定位到错误窗口。
  // [权衡] 首位字段一经写入不再变动，这是区间语义成立的前提。
  if (existing) {
    existing.eventCount += 1;
    existing.lastEventId = String(event.id);
    existing.lastSessionEventSequenceNumber = event.sequenceNumber;
    existing.payloadBytes += measureJsonBytes(event.payload);
    existing.payloadKinds[payloadKind] = (existing.payloadKinds[payloadKind] ?? 0) + 1;
    // [并发] 阈值判定发生在累加之后，保证冲刷窗口至少包含达到阈值的那两条事件。
    // 冲刷会同步删除条目，因此累加后的这个引用在此之后不可再被使用。
    // [权衡] 阈值触发是近似实时而非精确批次，不要指望 summary 条数等于事件数除以阈值。
    if (existing.eventCount >= SESSION_EVENT_APPEND_SUMMARY_FLUSH_COUNT) {
      flushSessionEventAppendAggregate.call(
        this,
        aggregateKey,
        existing,
        traceContext,
        "count_threshold",
      );
    }
    return true;
  }

  // [资源] 首次见到某个 turnId 加 type 时才建条目，条目数上限等于并发 Turn 数乘以聚合类型数。
  // turnId 缺失时用 session 作为键的一部分，保证没有 turn 归属的事件也能归并。
  // 这里不要顺手做 Map 的容量清理：清理点只在冲刷处，否则会把仍在累积的区间提前截断。
  aggregateMap.set(aggregateKey, {
    eventCount: 1,
    eventType: event.type,
    firstEventId: String(event.id),
    firstSessionEventSequenceNumber: event.sequenceNumber,
    lastEventId: String(event.id),
    lastSessionEventSequenceNumber: event.sequenceNumber,
    payloadBytes: measureJsonBytes(event.payload),
    payloadKinds: { [payloadKind]: 1 },
  });
  return true;
}

// [契约] 这是批量冲刷入口，只处理当前 runtime 的聚合，不跨实例。
// 早退条件同时判空 Map 和空条目，避免为无状态场景写一条零计数 summary。
// 遍历过程中条目会被删除，依赖 Map 迭代器允许边遍历边删除这一语义，不要改成先 forEach 再清理。
function flushSessionEventAppendAggregates(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  reason: "count_threshold" | "low_frequency_event",
): void {
  // [契约] 冲刷入口按 runtime 取 Map，取不到即视为无待冲刷内容。
  // 不要在这里新建 Map：新建会把没有聚合变成有一个空聚合，后续判空逻辑全部失效。
  const aggregateMap = sessionEventAppendAggregates.get(this);
  if (!aggregateMap || aggregateMap.size === 0) {
    return;
  }
  // [失败路径] 单个聚合的冲刷失败不会中断其余聚合，逐条处理即可。
  // 不要在循环里 await 任何 I/O：这里只写日志，插入异步会让删除与上报的次序变得不可预测。
  for (const [aggregateKey, aggregate] of aggregateMap) {
    flushSessionEventAppendAggregate.call(this, aggregateKey, aggregate, traceContext, reason);
  }
}

// [事务] 先删除再上报：即使 logger 抛错，也不会留下一个会再次被冲刷的重复条目。
// 删除使用可选链，是因为并发路径可能已经把条目移除，重复删除必须是无害的。
function flushSessionEventAppendAggregate(
  this: AgentRuntimeInternal,
  aggregateKey: string,
  aggregate: SessionEventAppendAggregate,
  traceContext: TraceContext,
  reason: "count_threshold" | "low_frequency_event",
): void {
  const aggregateMap = sessionEventAppendAggregates.get(this);
  aggregateMap?.delete(aggregateKey);
  // 日志治理原因：model streaming / progress 类事件与 token 流同频，
  // 逐条写默认日志会把 eventStore 索引复制成巨量 daily log；这里保留 seq 范围和 kind 分布用于定位。
  this.logger?.debug("Session event append summary", {
    ...traceContextToLogContext(traceContext),
    event: "event_store.appended.summary",
    eventCount: aggregate.eventCount,
    firstEventId: aggregate.firstEventId,
    firstSessionEventSequenceNumber: aggregate.firstSessionEventSequenceNumber,
    flushReason: reason,
    lastEventId: aggregate.lastEventId,
    lastSessionEventSequenceNumber: aggregate.lastSessionEventSequenceNumber,
    module: "core.runtime",
    payloadBytes: aggregate.payloadBytes,
    payloadKinds: aggregate.payloadKinds,
    sessionEventType: aggregate.eventType,
  });
}

function getSessionEventAppendAggregateMap(
  runtime: AgentRuntimeInternal,
): Map<string, SessionEventAppendAggregate> {
  let aggregateMap = sessionEventAppendAggregates.get(runtime);
  if (!aggregateMap) {
    aggregateMap = new Map();
    sessionEventAppendAggregates.set(runtime, aggregateMap);
  }
  return aggregateMap;
}

// [契约] payload kind 只用于诊断分布，缺省统一记 missing 标记，不要臆造类型名。
// 这里刻意不做 schema 校验：诊断路径不应因为上游 payload 结构演进就抛错。
function getPayloadKind(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const kind = (payload as Record<string, unknown>).kind;
    if (typeof kind === "string" && kind.length > 0) {
      return kind;
    }
  }
  return "<missing>";
}

// [失败路径] 序列化失败返回 0 而不是抛出：payload 可能含循环引用或 BigInt。
// 体积只是日志字段，宁可低估也不能让一条本可落库的事件因为测量失败而丢失。
function measureJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}

// [契约] 本函数按事件类型把内存事件翻译成 durable session entry，未匹配的类型直接返回。
// 它跑在事件已经落库之后，所以这里的失败不应让 append 整体失败：各分支自行 catch 并告警。
// [权衡] 把多事件类型的分支集中在一个函数里，是为了保证「哪些事件需要额外持久化」只有一份可读清单。
// 新事件若需要跨进程恢复，必须在这里显式加分支，不能依赖 eventStore 的内存重放。
async function persistDurableSessionEvent(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;

  // [契约] 终态事件必须同步刷新 session 的 lastOutcome 与 timeUpdated，然后原样返回。
  // CLI 在发布事件前已经持久化过结果，Host 冷启动只能读这条兜底记录，不能重新推导。
  // [失败路径] 这里的 updateSession 不 catch：终态写失败必须让整条 append 失败，否则恢复后状态是错的。
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    const payload = event.payload as { resultType?: string };
    // 终态由 CLI 在发布事件前持久化；Host 冷启动不能再把全部历史任务推导为成功。
    await this.sessionStore.updateSession({
      id: event.sessionId,
      lastOutcome:
        event.type === SessionEventType.TurnError
          ? "error"
          : payload.resultType === "cancelled"
            ? "interrupted"
            : "completed",
      timeUpdated: event.timestamp.getTime(),
    });
    return;
  }

  // [契约] checkpoint 的持久化交给专用模块，本函数只负责转发，不在这里解释 payload。
  // 把 checkpoint 逻辑内联进来会让事件层依赖 workspace 路径规则，边界随即模糊。
  if (event.type === SessionEventType.CheckpointCreated) {
    await persistWorkspaceCheckpointEntry(this, event, traceContext);
    return;
  }

  if (event.type === SessionEventType.RewindTriggered) {
    await persistWorkspaceFileRewindEntry(this, event, traceContext);
    return;
  }

  // [契约] 自动结束状态用 interactionId 作稳定 entry id，重复事件覆写同一行而不是追加。
  // entry 里冗余保存 eventId 与 sequenceNumber，是为了恢复时能把 entry 对回事件流的位置。
  // [失败路径] 这里的 catch 必须吞掉异常：自动结束只是辅助状态，写失败不能让用户输入流程卡住。
  if (event.type === SessionEventType.UserInputAutoResolutionUpdated) {
    const payload = event.payload as UserInputAutoResolutionUpdatedPayload;
    try {
      await this.sessionStore.saveSessionEntry?.({
        id: `user-input-auto-resolution:${payload.interactionId}`,
        sessionID: event.sessionId,
        type: SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
        time: {
          created: payload.autoResolution.startedAt,
          updated: event.timestamp.getTime(),
        },
        data: {
          interactionId: payload.interactionId,
          toolCallId: payload.toolCallId,
          autoResolution: payload.autoResolution,
          eventId: event.id,
          sequenceNumber: event.sequenceNumber,
          traceId: event.traceId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      });
    } catch (error) {
      // 原因：自动结束绝对时间若只在内存 eventStore，CLI 重启会错误重开五分钟窗口。
      // session entry 使用 interactionId 稳定覆写最新阶段，恢复时只读取最终状态。
      this.logger?.warn("Failed to persist user input auto-resolution state", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "user_input_auto_resolution.persist_failed",
        interactionId: payload.interactionId,
        module: "core.runtime",
        status: "failed",
      });
    }
    return;
  }

  // ── session_input 账本：queue/steer 生命周期集中记账 ──
  // 在事件汇处理（而非各发射点）：TurnSteerQueued/Discarded 有 5+ 个发射点
  // （steer/编辑重发/单删/清空/resume 清扫），单点接线保证不漏。promotion 在
  // drain 持久化处原子完成（persistUserPrompt sessionInputId 路径），不经此处。
  // [契约] queue 与 steer 的入账统一发生在事件汇，而不是各发射点。
  // TurnSteerQueued 有 5 个以上发射点（steer、编辑重发、单删、清空、resume 清扫），单点接线才能保证不漏。
  // promotion 的落账在 drain 持久化处原子完成，不经过这里，避免同一条输入被记两次。
  if (event.type === SessionEventType.TurnSteerQueued) {
    const payload = event.payload as {
      pendingInputId: string;
      input: string;
      commandKind?: string;
      delivery?: "guide" | "queue";
      intent?: TurnInputIntentMetadata;
    };
    const conversationInputIntent = buildPersistedConversationInputIntent(
      payload.input,
      payload.intent,
      "queued",
    );
    try {
      await this.sessionStore.saveSessionInput?.({
        id: payload.pendingInputId,
        sessionID: event.sessionId,
        kind: payload.intent?.kind ?? payload.commandKind ?? "sendText",
        delivery: payload.delivery ?? "queue",
        payload: {
          text: payload.input,
          ...(payload.intent ? { intent: payload.intent } : {}),
          ...(conversationInputIntent ? { conversationInputIntent } : {}),
        },
      });
    } catch (error) {
      this.logger?.warn("Failed to admit session input to ledger", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_input.admit_failed",
        module: "core.runtime",
        pendingInputId: payload.pendingInputId,
        status: "failed",
      });
    }
    return;
  }
  // [契约] 投递方式变化只更新已有账本行的 delivery 与 intent，不新建行。
  // 若账本里没有对应 id，更新是空操作，这是允许的：账本可能因写入失败而缺失该行。
  if (event.type === SessionEventType.TurnSteerDeliveryChanged) {
    const payload = event.payload as {
      admittedDelivery: "queue";
      intent?: TurnInputIntentMetadata;
      pendingInputId: string;
    };
    try {
      await this.sessionStore.updateSessionInputs?.({
        sessionID: event.sessionId,
        updates: [
          {
            delivery: payload.admittedDelivery,
            id: payload.pendingInputId,
            ...(payload.intent ? { intent: payload.intent } : {}),
          },
        ],
      });
    } catch (error) {
      this.logger?.warn("Failed to persist session input delivery fallback", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_input.delivery_change_failed",
        module: "core.runtime",
        pendingInputId: payload.pendingInputId,
        status: "failed",
      });
    }
    return;
  }
  // [契约] 丢弃语义必须区分「用户动作」和「重启清扫」，两者的终态不同。
  // 遍历 pendingInputIds 逐条结算，单条失败只告警，继续处理其余 id。
  if (event.type === SessionEventType.TurnSteerDiscarded) {
    const payload = event.payload as {
      pendingInputIds: string[];
      reason?: string;
    };
    // sendQueuedNow 只是在执行权已保留后把项从 queue 投影摘除；此时若把 ledger
    // 标成 cancelled，会制造 remove→后台 user message promotion 之间的崩溃丢失窗口。
    // 保持 admitted，随后由 persistUserPrompt 原子置 promoted；若进程先退出，恢复清扫
    // 会把它明确置 discarded/session_resumed。
    // [契约] reason 为 promoted 表示这条输入已通过 promotion 接管，账本必须保持 admitted 不动。
    // [失败路径] 若在这里改标 cancelled，remove 与后台 user message promotion 之间的崩溃窗口会直接丢掉用户输入。
    // [事务] 内存队列投影可以先摘除，账本必须等真正的 promotion 落账，两者不是同一次写。
    // 这条判定必须放在 reason 到 status 的映射之前，顺序反了就会先写一次 cancelled 再返回。
    if (payload.reason === "promoted") return;
    // session_resumed=重启不保留队列（裁决，留痕不静默）；其余用户动作归 cancelled。
    const status = payload.reason === "session_resumed" ? "discarded" : "cancelled";
    for (const pendingInputId of payload.pendingInputIds) {
      try {
        await this.sessionStore.settleSessionInput?.({
          id: pendingInputId,
          sessionID: event.sessionId,
          status,
          reason: payload.reason,
        });
      } catch (error) {
        this.logger?.warn("Failed to settle session input in ledger", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "session_input.settle_failed",
          module: "core.runtime",
          pendingInputId,
          status: "failed",
        });
      }
    }
    return;
  }

  // [契约] 到这一步只剩目标校验一种事件，其余类型在此统一收口返回。
  // 新增需要持久化的类型必须加在上面的分支链里，而不是把这条兜底判断放宽。
  if (event.type !== SessionEventType.TargetCompletionVerification) {
    return;
  }

  try {
    const timestamp = event.timestamp.getTime();
    const payload = event.payload as TargetCompletionVerificationPayload;
    const timelinePartId = targetCompletionVerificationTimelinePartId(payload);
    const existingTimeline = await readExistingTimelineTiming.call(this, {
      partID: timelinePartId,
      sessionID: event.sessionId,
    });
    const created = existingTimeline?.messageCreated ?? timestamp;
    const startedAt = existingTimeline?.partStarted ?? timestamp;
    if (this.sessionStore.saveSessionEntry) {
      await this.sessionStore.saveSessionEntry({
        id: String(event.id),
        sessionID: event.sessionId,
        type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        time: {
          created: timestamp,
          updated: timestamp,
        },
        // goal verifier 生命周期是恢复 UI 轮次和分割线的业务事实；
        // 只写内存 eventStore 会导致冷启动后 goal iteration/todo 分组丢失。
        data: {
          eventId: event.id,
          payload: event.payload,
          sequenceNumber: event.sequenceNumber,
          traceId: event.traceId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      });
    }
    await this.persistAssistantTimelinePartForSession({
      sessionId: event.sessionId,
      messageID: targetCompletionVerificationTimelineMessageId(payload),
      partID: timelinePartId,
      parentID: payload.anchorAssistantMessageId,
      created,
      completed: payload.status === "started" ? undefined : timestamp,
      finish: payload.status,
      timeline: {
        timelineType: "goal_verification",
        display: "separator",
        status: payload.status,
        anchorMessageId: payload.anchorAssistantMessageId,
        anchorTurnId: payload.anchorTurnId,
        targetId: payload.targetId,
        verificationId: payload.verificationId,
        goalIteration: payload.goalIteration,
        verification: payload.verification,
        time: {
          start: startedAt,
          end: payload.status === "started" ? undefined : timestamp,
        },
      },
      traceContext,
    });
  } catch (error) {
    this.logger?.warn("Failed to persist target completion verification event", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_entry.target_completion_verification.persist_failed",
      module: "core.runtime",
      sessionEventType: event.type,
      status: "failed",
    });
  }
}

function targetCompletionVerificationTimelineMessageId(
  payload: TargetCompletionVerificationPayload,
): MessageId {
  return createMessageId(`goal_verify_${targetCompletionVerificationTimelineKey(payload)}`);
}

function targetCompletionVerificationTimelinePartId(
  payload: TargetCompletionVerificationPayload,
): PartId {
  return createPartId(`goal_verify_${targetCompletionVerificationTimelineKey(payload)}_timeline`);
}

// [契约] 键优先用 targetId 加 goalIteration，缺失迭代号时才退化到 verificationId。
// 键决定 messageId 与 partId，一旦口径变化，历史分割线就对不回同一条消息。
function targetCompletionVerificationTimelineKey(
  payload: TargetCompletionVerificationPayload,
): string {
  return payload.goalIteration !== undefined
    ? `${payload.targetId}_${payload.goalIteration}`
    : payload.verificationId;
}

// [资源] 这里会拉取整个会话的消息投影来查一个 part，属于恢复路径上的重查询。
// 只在目标校验事件上触发，不要把它挪到高频分支里。
// [契约] 找到时间线后返回消息创建时间与 part 开始时间供分割线沿用，找不到则由调用方用事件时间兜底。
async function readExistingTimelineTiming(
  this: AgentRuntimeInternal,
  input: { partID: PartId; sessionID: SessionId },
): Promise<{ messageCreated?: number; partStarted?: number } | undefined> {
  const messages = await this.sessionStore?.messages({ sessionID: input.sessionID });
  if (!messages) return undefined;
  for (const message of messages) {
    const part = message.parts.find((candidate) => candidate.id === input.partID);
    if (part?.type !== "timeline") continue;
    return {
      messageCreated: message.info.time.created,
      partStarted: part.time?.start,
    };
  }
  return undefined;
}

// [契约] sink 广播按注册顺序串行 await，保证单个 sink 看到的事件次序与 eventStore 一致。
// 不要改成并行 Promise.all：并行会让慢 sink 看到的事件顺序与快 sink 不同。
// [权衡] 串行意味着最慢的 sink 决定 append 的返回时间，这是为顺序一致性付出的延迟代价。
export async function notifyEventSinks(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  // [失败路径] 每个 sink 独立 try/catch：一个遥测通道异常不能阻断 UI 订阅。
  // 异常只记 warn 并继续下一个 sink，不重试：事件本身已经落库，sink 可以从 store 重新对齐。
  // 日志里带 sessionEventType 而不带 payload，避免把用户内容写进诊断日志。
  for (const sink of this.eventSinks) {
    try {
      await sink.onSessionEvent(event);
    } catch (error) {
      this.logger?.warn("Session event sink failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_event_sink.failed",
        module: "core.runtime",
        sessionEventType: event.type,
        status: "failed",
      });
    }
  }
}

/**
 * 会话是否已进入持久化 store（首条输入 / 外部活动 / 直接启动的启动轮 / 冷恢复任一路径落过行）。
 * 协议层的 session record 以它为 draft 判定的事实源（bootstrap `onSessionEvent` 每条事件对齐一次），
 * 不再靠各命令 handler 各自翻 `record.persistence`。
 */
export function isSessionPersisted(this: AgentRuntimeInternal): boolean {
  return this.sessionPersisted;
}

const pendingSessionPersistence = new WeakMap<AgentRuntimeInternal, Promise<void>>();

// [并发] 这是 session 首次落库的唯一入口，必须单飞：并发调用共享同一个 Promise。
// 已持久化或没有 sessionStore 时直接返回，不做任何写入。
// [契约] 返回的 Promise 在 finally 中清理，失败后允许下一次调用重试。
export async function ensureSessionPersisted(
  this: AgentRuntimeInternal,
  input: string,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore || this.sessionPersisted) return;
  // [并发] pending 检查必须早于任何 await，才能在同一个 tick 内合并并发调用。
  // 这里读取的是 WeakMap 而不是实例字段，避免给 runtime 增加可被序列化的状态。
  const pending = pendingSessionPersistence.get(this);
  if (pending) return pending;
  // App sampling 可与首轮任务并发；同一任务创建必须合并，避免重复插入及模型配置覆盖。
  const created = persistSession
    .call(this, input, traceContext)
    .finally(() => pendingSessionPersistence.delete(this));
  pendingSessionPersistence.set(this, created);
  return created;
}

// [事务] 创建会话是整条持久化链的第一笔写，后续 entry、模型选型、shell 快照都依赖它。
// 进入时再次判重，是因为等待 pending 的调用方可能在上一轮已经完成持久化。
// [失败路径] 任一阶段失败都向上抛出，并把 phase 写进日志，便于判断失败发生在哪一步。
async function persistSession(
  this: AgentRuntimeInternal,
  input: string,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore || this.sessionPersisted) return;

  const startedAt = Date.now();
  let phase = "session_store.create";
  this.logger?.info("Session persistence started", {
    ...traceContextToLogContext(traceContext),
    event: "session.persistence.started",
    module: "core.runtime",
    sessionId: this.sessionId,
    status: "started",
  });

  try {
    const directory = this.workingDirectory;
    // bootstrap 会用 path.resolve 规范化执行 cwd；过去又把同一个值写入
    // session.path/directory，导致本地 workspacePath 的末尾 `/` 丢失。冷恢复随后按精确
    // workspaceKey 查 provider registry 时就会落到另一个身份。持久化必须保留协议入口路径。
    // [契约] 持久化的 directory 与 path 必须保留协议入口原始路径，不能用 path.resolve 规范化后的值。
    // bootstrap 已规范化执行 cwd，若这里再写同一个值，本地 workspacePath 末尾的斜杠会丢失。
    // 冷恢复按精确 workspaceKey 查 provider registry，路径少一个字符就会落到另一个身份。
    const persistedWorkspacePath = this.config.workspacePath ?? directory;
    const title = titleFromInput(input);
    const workspaceIdentity = this.config.memory?.workspaceIdentity?.trim();
    await this.sessionStore.createSession({
      id: this.sessionId,
      projectID: projectIdFromDirectory(directory),
      // Memory workspaceIdentity 是上游提供的不透明隔离键。这里只做类型品牌化，
      // 不能调用会改写字符串的 ID 生成器，否则恢复后的 Memory root 会发生漂移。
      workspaceID: this.config.workspaceIdentity ?? (workspaceIdentity as WorkspaceId | undefined),
      parentID: this.config.parentSessionId,
      traceID: traceContext.traceId,
      taskType: this.config.taskType,
      slug: slugify(this.sessionId),
      directory: persistedWorkspacePath,
      path: persistedWorkspacePath,
      title,
      titleSource: "first_input",
      version: this.appVersion,
      permission: {
        mode: this.config.mode ?? "build",
      },
    });
    // 初始模型过去只写进首条 user message，没有写稳定的 session selection。
    // 冷恢复从末尾 assistant 反推时只能得到 provider/model，必选 reasoning 会丢失，
    // Subagent 因此在 hydration 前就无法重新创建 Model。会话创建时同步固定完整选型，
    // 后续显式切模仍复用同一个稳定 entry 覆盖。
    phase = "session_model_selection";
    // [契约] 会话创建时同步固定完整模型选型，包含 provider、model 与 reasoning 档位。
    // 只写首条 user message 不够：冷恢复从末尾 assistant 反推会丢 reasoning，Subagent 无法重建 Model。
    const initialSelection = this.getSessionModelSelection();
    if (initialSelection) await persistRuntimeModelSelection(this, initialSelection);
    phase = "session_shell_snapshot";
    await persistSessionShellEnvironmentSnapshot(this, traceContext);
    phase = "session_execution_state";
    await this.sessionStore.saveSessionEntry?.(
      buildExecutionStateEntry(this.sessionId, readRuntimeExecutionState(this)),
    );
    // `/workflow` 作为首轮时激活先于落盘（launch.md「On demand: activation」），entry 在这里补写。
    await writeDynamicWorkflowActivationEntryIfActivated(this);
    // [契约] 只有 createSession、模型选型、shell 快照、执行态与 workflow 激活全部写完后才置位。
    // 提前置位会让后续调用直接跳过，会话永久缺记录，而且不会再有第二次补偿机会。
    // [事务] 置位之后才发 SessionTitleUpdated 事件，保证下游 syncer 看到标题时 session 行已存在。
    this.sessionPersisted = true;
    this.logger?.debug("Session persisted", {
      ...traceContextToLogContext(traceContext),
      event: "session.persisted",
      module: "core.runtime",
      status: "completed",
    });
    // 之前只把 first_input title 写进 sessionStore 但不 appendEvent，
    // 导致下游 (z-code services 层的 task index sqlite syncer) 等不到 session.titleUpdated，
    // 侧边栏一直显示 "New session" 直到后台 LLM 生成 title。这里补一条 source="first_input"
    // 事件，让 desktop/web/mobile 三端的 syncer 走同一条收敛路径。
    // [契约] 这里补发 first_input 标题事件，让 desktop/web/mobile 三端 syncer 走同一条收敛路径。
    // 只写 sessionStore 不 appendEvent 的话，侧边栏会一直显示新会话占位直到后台 LLM 生成标题。
    // source 固定为 first_input：下游据此区分人工改名与首次输入推导，不要传当前标题来源。
    phase = "session_title_event";
    await this.appendEvent(
      this.createEvent(
        SessionEventType.SessionTitleUpdated,
        {
          previousTitle: "",
          source: "first_input",
          title,
        },
        traceContext,
      ),
      traceContext,
    );
    this.logger?.info("Session persistence completed", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      event: "session.persistence.completed",
      module: "core.runtime",
      sessionId: this.sessionId,
      status: "completed",
    });
  } catch (error) {
    this.logger?.warn("Session persistence failed", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session.persistence.failed",
      module: "core.runtime",
      phase,
      sessionId: this.sessionId,
      status: "failed",
    });
    // [失败路径] 与 appendEvent 一致，这里的错误必须重抛，phase 供调用方定位失败阶段。
    // 不要在这里把 sessionPersisted 置位或回滚部分写入，清理责任属于上层重试策略。
    throw error;
  }
}
