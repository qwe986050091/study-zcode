/**
 * ============================================================================
 * runtime/methods/compact-persistence.ts —— compact 的 durable 事实与冷恢复收敛
 * ============================================================================
 * 【定位】链路 4 + 链路 5：compact timeline / summary 消息 / compaction part 的唯一持久化入口。
 * 【输入/输出】输入 timeline 上下文、provider 摘要与边界 payload；输出 store 写入 + Compact* 事件。
 * 【关键口径】连续更新只在 update 显式给出时覆盖字段，避免旧字段被写成 undefined；
 *             summary/reminder 与历史替换是一次事务化写入，失败按已写入 id 回滚；
 *             resume 时 running/retrying 的 timeline 必须收敛为唯一终态（链路 5）。
 * ============================================================================
 */
// compact 持久化：把正在进行的压缩写成可冷恢复的事实，而不是只活在内存里的快照
// 写入骨架固定：assistant timeline part 在前，compaction part 在后，两者共享 operationId 与 partId
// 冷恢复只修补中间态，已到终态的记录一律视为既成事实，不再改写
// store 端口全部可选，缺失时降级为只发事件不落库，调用方必须能继续跑完这一轮
// INV-01 timeline part 必须先于 compaction part 落库；守住位置：persistCompactTimeline 的两次写库顺序；改错故障：中途崩溃后只剩 model 侧标记，压缩分隔从 UI 消失
// INV-02 同一 timeline 复用同一 partId，重复持久化是覆盖而非追加；守住位置：persistCompactTimeline 的 compaction part id 取值；改错故障：同一操作在历史里堆出多条重复记录
// INV-03 update 未显式提供的字段绝不写入 payload；守住位置：buildCompactTimelinePayload 的逐字段判断；改错故障：一次状态推进清空前序 attempt，重试代数与边界指针丢失
// INV-04 两份 part 共用同一个 created 时间基准；守住位置：persistCompactTimeline 计算 created 的回落逻辑；改错故障：冷恢复无法按时间配对，压缩段与摘要错位
// INV-05 无 sessionStore 时写路径静默返回且不抛错；守住位置：persistCompactTimeline 与 persistCompactSummary 的首个早退；改错故障：未配置持久化就完全无法使用 compact
// INV-06 失败收口自身的异常只能降级为 warn，不得替换原始错误；守住位置：finishCompactTimelineFailure 的 catch 分支；改错故障：用户看到持久化报错，而不是真正的压缩失败原因
// INV-07 取消映射为 Interrupted，其余异常映射为 Failed；守住位置：finishCompactTimelineFailure 的终态判定；改错故障：用户主动中断被当成故障，触发无意义的自动重试
// INV-08 终态写入必须显式带 replace 覆盖历史状态；守住位置：失败收口与冷恢复的 payload 构造；改错故障：库里残留 running，下次恢复再被误判为中断
// INV-09 恢复只改写 started 与 retrying，completed 和 failed 不得重写；守住位置：recoverInterruptedCompactTimelines 的状态过滤；改错故障：冷启动覆盖已完成的真实结果
// INV-10 以 operationId 索引 compactBoundary，作为摘要已提交的唯一证据；守住位置：recoverInterruptedCompactTimelines 的索引构建；改错故障：已有摘要的 timeline 被判为中断，摘要与状态自相矛盾
// INV-11 缺 boundary 的中间态必须收敛为 Interrupted；守住位置：recoverInterruptedCompactTimelines 的状态判定；改错故障：UI 永久停在压缩中，用户无法重新发起压缩
// INV-12 写库后必须把同一终态回填内存 part；守住位置：recoverInterruptedCompactTimelines 的字段覆盖；改错故障：同一轮 resume 的后续逻辑仍按 running 处理，重复收敛
// INV-13 边界索引只收录同时具备 operationId 与 compactBoundary 的 part；守住位置：recoverInterruptedCompactTimelines 的索引过滤；改错故障：空边界进入索引，覆盖真实摘要指针
// INV-14 summary 消息对 UI 与 transcript 隐藏，但必须对 provider 可见；守住位置：persistCompactSummary 的 semantics 字段；改错故障：压缩后模型看不到摘要，历史等于被凭空截断
// INV-15 摘要消息、文本 part、compaction part 与 reminder 属于同一次历史替换；守住位置：persistCompactSummary 的 try 域；改错故障：半写入历史让模型读到断裂上下文
// INV-16 回滚账本只登记真正落库的消息 id；守住位置：persistCompactSummary 的账本追加；改错故障：删除从未写入的 id 或漏删已写入的 reminder
// INV-17 回滚失败不得吞掉原始错误；守住位置：persistCompactSummary 的 catch 重抛；改错故障：compact 静默成功，但历史已残缺
// INV-18 attempt 与 maxAttempts 原样透传到 part 与事件；守住位置：buildCompactTimelinePayload 与 persistCompactTimeline 的字段搬运；改错故障：冷恢复算不出剩余重试次数，自动压缩提前放弃
// INV-19 新增 payload 字段一律可选，读侧按缺省回退推导；守住位置：buildCompactTimelinePayload 的可选入参与恢复时的 phase 回落；改错故障：旧会话缺字段导致恢复整批跳过
import {
  CompactTrigger,
  CompactTimelineDisplay,
  CompactTimelineStatus,
  SessionEventType,
  createPartId,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CompactBoundaryPayload,
  CompactTimelinePayload,
  MessageId,
  MessageWithParts,
  Model,
  PartId,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import {
  defaultCompactPhaseForTrigger,
  defaultCompactReasonForTrigger,
  compactFailureReasonFromError,
  isTurnCancellationError,
} from "../helpers/index.js";
import type { CompactTimelineContext } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  persistRuntimeReminderMessage,
  removeRuntimePersistenceMessagesBestEffort,
  resolvePersistedReminderModel,
} from "./runtime-reminder-persistence.js";

// 纯构造：不读 store、不发事件，只把 timeline 快照与本轮 update 合成 payload
// timeline 只读、update 是增量，合并方向单一，不允许回写 timeline
// display 固定为 Separator，压缩在 transcript 里的呈现形态由这里单点决定
// replace 透传而不推导，是否覆盖历史由调用方的语义决定，构造层不猜
// 未列出的字段按缺省省略，而不是写成显式 undefined
// 权衡：逐字段搬运啰嗦，换来状态推进不会误清除前序信息
export function buildCompactTimelinePayload(
  this: AgentRuntimeInternal,
  timeline: CompactTimelineContext,
  update: {
    attempt?: number;
    boundaryId?: string;
    endedAt?: number;
    maxAttempts?: number;
    postCompactTokenCount?: number;
    reason?: string;
    replace?: boolean;
    status: CompactTimelineStatus;
    summaryMessageId?: MessageId;
    tailStartMessageId?: MessageId;
    truePostCompactTokenCount?: number;
  },
): CompactTimelinePayload {
  const payload: CompactTimelinePayload = {
    operationId: timeline.operationId,
    messageId: timeline.messageId,
    partId: timeline.partId,
    status: update.status,
    trigger: timeline.trigger,
    phase: timeline.phase,
    compactReason: timeline.compactReason,
    display: CompactTimelineDisplay.Separator,
    preCompactTokenCount: timeline.preCompactTokenCount,
    sourceCommandId: timeline.sourceCommandId,
    startedAt: timeline.startedAt,
  };
  // 同一个 timeline 会随状态推进被反复重写：只搬运 update 显式提供的字段，
  // 不把未提供的字段写成 undefined，否则事件/persist 会丢失前序 attempt、boundary 等信息。
  if (update.replace !== undefined) payload.replace = update.replace;
  if (update.reason !== undefined) payload.reason = update.reason;
  if (update.attempt !== undefined) payload.attempt = update.attempt;
  if (update.maxAttempts !== undefined) payload.maxAttempts = update.maxAttempts;
  if (update.boundaryId !== undefined) payload.boundaryId = update.boundaryId;
  if (update.summaryMessageId !== undefined) payload.summaryMessageId = update.summaryMessageId;
  if (update.tailStartMessageId !== undefined) {
    payload.tailStartMessageId = update.tailStartMessageId;
  }
  if (update.postCompactTokenCount !== undefined) {
    payload.postCompactTokenCount = update.postCompactTokenCount;
  }
  if (update.truePostCompactTokenCount !== undefined) {
    payload.truePostCompactTokenCount = update.truePostCompactTokenCount;
  }
  if (update.endedAt !== undefined) payload.endedAt = update.endedAt;
  return payload;
}

// 写入口：一次调用落两份事实，顺序、字段与时间基准都由本函数固定
// 并发语义：同一 operationId 的重复调用是幂等覆盖，这里不加锁也不去重
// 失败语义：任一写库抛错就中断，异常向上冒泡，本函数不吞也不降级
// 不在这里发事件：事件由调用方在写成功后追加，保证持久化先于通知
// 权衡：两次独立写库不是真事务，崩溃窗口内可能只有 timeline 而没有 compaction
// 除 startedAt 外不补任何缺省：其余字段缺省语义归属 payload 构造层，避免两处漂移
export async function persistCompactTimeline(
  this: AgentRuntimeInternal,
  payload: CompactTimelinePayload,
  traceContext: TraceContext,
): Promise<void> {
  // sessionStore 是可选端口：没有 durable 存储时不写 timeline，只由调用方继续发事件（链路 5 降级）。
  if (!this.sessionStore) return;

  // startedAt 缺失时用当前时间补齐，保证 timeline part 与 compaction part 的 time.start 一致。
  const created = payload.startedAt ?? Date.now();
  // 先写 assistant timeline part（UI 可见的分隔），再写 compaction part（model 历史标记）；
  // 两份事实共用 operationId/partId，冷恢复和 UI 才能对齐同一次压缩。
  // timeline part 是 UI 可见投影，compaction part 是 model 历史标记，语义不同不能合并
  // 这里把边界、摘要指针与 token 口径整体投影进 UI 侧，供分隔组件直接渲染
  // 投影只搬字段不做补算，缺的值留给冷恢复的缺省推导兜底
  // 风险点：新增 timeline 字段必须两处投影同时改，否则 UI 与 model 历史口径分叉
  await this.persistAssistantTimelinePartForSession({
    sessionId: this.sessionId,
    messageID: payload.messageId,
    partID: compactTimelinePartId(payload),
    created,
    completed: payload.endedAt,
    finish: payload.status,
    timeline: {
      timelineType: "context_compaction",
      display: payload.display,
      status: payload.status,
      operationId: payload.operationId,
      sourceCommandId: payload.sourceCommandId,
      trigger: payload.trigger,
      phase: payload.phase,
      compactReason: payload.compactReason,
      boundaryId: payload.boundaryId,
      summaryMessageId: payload.summaryMessageId,
      preCompactTokenCount: payload.preCompactTokenCount,
      postCompactTokenCount: payload.postCompactTokenCount,
      truePostCompactTokenCount: payload.truePostCompactTokenCount,
      attempt: payload.attempt,
      maxAttempts: payload.maxAttempts,
      reason: payload.reason,
      time: {
        start: payload.startedAt,
        end: payload.endedAt,
      },
    },
    traceContext,
  });
  await this.persistPart(
    {
      id: payload.partId ?? createPartId(),
      sessionID: this.sessionId,
      messageID: payload.messageId,
      type: "compaction",
      auto: payload.trigger === CompactTrigger.Auto,
      trigger: payload.trigger,
      phase: payload.phase,
      compactReason: payload.compactReason,
      operationId: payload.operationId,
      timelineStatus: payload.status,
      timelineDisplay: payload.display,
      replace: payload.replace,
      reason: payload.reason,
      attempt: payload.attempt,
      maxAttempts: payload.maxAttempts,
      boundaryId: payload.boundaryId,
      summaryMessageId: payload.summaryMessageId,
      tail_start_id: payload.tailStartMessageId,
      preCompactTokenCount: payload.preCompactTokenCount,
      postCompactTokenCount: payload.postCompactTokenCount,
      truePostCompactTokenCount: payload.truePostCompactTokenCount,
      time: {
        start: payload.startedAt,
        end: payload.endedAt,
      },
    },
    traceContext,
  );
}

// 确定性 id 派生：以 partId 退化为 operationId 再拼固定后缀作为 timeline 主键
// 这层派生是覆盖写的支点，id 稳定才能让重写命中同一行而不是新建分隔
// 退化为 operationId 保证 partId 缺失时仍稳定，避免一次压缩出现两条分隔
// 权衡：派生 id 不可读，排查时需要用 operationId 反查真实 part
function compactTimelinePartId(payload: CompactTimelinePayload): PartId {
  // 由 partId/operationId 派生的确定性 id：同一操作再次持久化是覆盖，
  // 不会在 timeline 里堆出多条重复分隔。
  return createPartId(`${String(payload.partId ?? payload.operationId)}_timeline`);
}

// 失败收口唯一入口：写终态 durable 事实，并补发 CompactFailed 事件
// 不清理已写入的 summary 或 part，回滚责任在 persistCompactSummary，避免双重删除
// 不重抛异常：调用方已持有原始 error，这里再抛会掩盖 compact 的真实失败点
export async function finishCompactTimelineFailure(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    attempt?: number;
    error: unknown;
    events: SessionEvent[];
    maxAttempts?: number;
    timeline: CompactTimelineContext;
    traceContext: TraceContext;
  },
): Promise<void> {
  // 取消 → Interrupted，其余异常 → Failed：这是终态口径，冷恢复和 UI 据此区分
  // "用户中断"与"压缩失败"，两者不能混用。
  // 判定顺序固定：先看取消再看其他异常，否则 abort 会被归类成 Failed
  // abortSignal 与 error 同时参与判定，因为取消可能先于异常抛出
  // 终态一旦选出就不再翻转，后续重试必须新建 timeline 而非复用本条
  const status = isTurnCancellationError(options.error, options.abortSignal)
    ? CompactTimelineStatus.Interrupted
    : CompactTimelineStatus.Failed;
  const payload = this.buildCompactTimelinePayload(options.timeline, {
    attempt: options.attempt,
    endedAt: Date.now(),
    maxAttempts: options.maxAttempts,
    reason: compactFailureReasonFromError(options.error),
    replace: true,
    status,
  });

  // 失败收口本身也可能失败：这里吞掉持久化错误只记 warn，避免二次失败覆盖真正的 compact 错误；
  // 调用方仍会拿到原始 error 决定是否终止 turn。
  try {
    await this.persistCompactTimeline(payload, options.traceContext);
    const event = this.createEvent(SessionEventType.CompactFailed, payload, options.traceContext);
    await this.appendEvent(event, options.traceContext);
    options.events.push(event);
  } catch (timelineError) {
    this.logger?.warn("Compact timeline failure state could not be persisted", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: timelineError instanceof Error ? timelineError.message : String(timelineError),
      event: "compact.timeline.persist_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

// 冷恢复入口：把上次进程留下的中间态收敛成可展示、可继续的终态
// 事实来源是入参 messages 快照，不回查 store，也不重新反序列化
// 返回修复条数，供上层决定是否重放事件或刷新 UI
// 幂等：同一批 messages 重复调用结果一致，终态不会再被过滤命中
// 不在此合并重复 timeline，去重依赖 operationId，属于上游反序列化职责
export async function recoverInterruptedCompactTimelines(
  this: AgentRuntimeInternal,
  messages: MessageWithParts[],
  traceContext: TraceContext,
): Promise<number> {
  // 没有 sessionStore 时不存在需要修复的持久化 timeline，直接返回 0。
  if (!this.sessionStore) return 0;

  // 先建 operationId → boundary 索引：boundary 的存在是"摘要已经提交"的唯一证据。
  // 先建索引再扫描：两遍遍历把边界查找从平方级降到线性
  // 键取 operationId 而非 partId，因为 boundary 挂在 compaction part、timeline 用另一条 id
  // 同一 operationId 出现多个 boundary 时后者覆盖前者，正常数据不应发生
  // 权衡：多一份 Map 换一次遍历，compaction part 远少于普通 part
  const boundaryByOperationId = new Map<string, CompactBoundaryPayload>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "compaction" || !part.operationId || !part.compactBoundary) continue;
      boundaryByOperationId.set(part.operationId, part.compactBoundary);
    }
  }

  let recovered = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      // 只修复 started/retrying；completed/failed/interrupted 已是终态，重复改写会覆盖真实结果。
      if (
        part.type !== "compaction" ||
        !isRecoverableRunningCompactTimelineStatus(part.timelineStatus) ||
        !part.operationId
      ) {
        continue;
      }

      // 收敛点：boundary 存在即认定摘要已提交，token 口径从 boundary 回填
      // phase 与 compactReason 三级回落：part 优先，其次 boundary，最后按 trigger 取默认值
      // 有 boundary 时补 Completed 并写入 summaryMessageId 与 tailStartMessageId 指针
      // 无 boundary 时只写 Interrupted，不臆造边界信息，避免伪造摘要锚点
      // 不校验 boundary 与 part 的一致性，冲突时以 boundary 为准，属于数据修复范畴
      const boundary = boundaryByOperationId.get(part.operationId);
      // 有 boundary → 摘要已落库，补 Completed；没有 → 进程在压缩中途退出，收敛为 Interrupted。
      // 不允许保持 running：否则 UI/冷恢复会一直显示进行中的压缩。
      const status = boundary ? CompactTimelineStatus.Completed : CompactTimelineStatus.Interrupted;
      const timeline: CompactTimelineContext = {
        operationId: part.operationId,
        messageId: part.messageID,
        partId: part.id,
        trigger: part.trigger ?? CompactTrigger.Manual,
        phase:
          part.phase ??
          boundary?.phase ??
          defaultCompactPhaseForTrigger(part.trigger ?? CompactTrigger.Manual),
        compactReason:
          part.compactReason ??
          boundary?.compactReason ??
          defaultCompactReasonForTrigger(part.trigger ?? CompactTrigger.Manual),
        startedAt: part.time?.start ?? message.info.time.created,
        preCompactTokenCount: part.preCompactTokenCount,
      };
      const payload = this.buildCompactTimelinePayload(timeline, {
        attempt: part.attempt,
        boundaryId: boundary?.boundaryId,
        endedAt: Date.now(),
        maxAttempts: part.maxAttempts,
        postCompactTokenCount: boundary?.postCompactTokenCount,
        replace: true,
        status,
        summaryMessageId: boundary?.summaryMessageIds[0],
        tailStartMessageId: boundary?.lastSummarizedMessageId,
        truePostCompactTokenCount: boundary?.truePostCompactTokenCount,
      });
      await this.persistCompactTimeline(payload, traceContext);
      // 同步内存 part 到刚写入的终态，避免本次 resume 后续逻辑继续读到旧 running 状态。
      Object.assign(part, {
        timelineStatus: payload.status,
        phase: payload.phase,
        compactReason: payload.compactReason,
        replace: payload.replace,
        attempt: payload.attempt,
        maxAttempts: payload.maxAttempts,
        boundaryId: payload.boundaryId,
        summaryMessageId: payload.summaryMessageId,
        tail_start_id: payload.tailStartMessageId,
        postCompactTokenCount: payload.postCompactTokenCount,
        truePostCompactTokenCount: payload.truePostCompactTokenCount,
        time: {
          start: payload.startedAt,
          end: payload.endedAt,
        },
      });
      recovered += 1;
    }
  }

  return recovered;
}

// 可恢复状态白名单只有两种：Started 与 Retrying
// Retrying 必须并入：自动压缩在 retry 间隔留下该状态，进程退出时它就是中间态
// 白名单之外一律不修：Completed、Failed、Interrupted 已是最终答案
// 纯函数、无副作用，独立出来是为了让恢复循环的过滤条件可单测
function isRecoverableRunningCompactTimelineStatus(
  status: CompactTimelineStatus | undefined,
): boolean {
  // 自动 compact retry 会把同一个 timeline 持久化成 retrying；
  // 进程在 retry 间隔退出时，resume 必须把它和 started 一样收敛为 interrupted/completed。
  return status === CompactTimelineStatus.Started || status === CompactTimelineStatus.Retrying;
}

// 摘要提交入口：summary 消息、文本 part、compaction part、reminder 四件事一起做
// created 只取一次：四份事实共用同一时间基准，冷恢复才能按时间还原顺序
// modelSelection 走统一解析，保证摘要与 reminder 用同一模型口径
// 不校验 content 与 summary 的一致性，两者来源不同，空值由调用方保证
// 失败路径：任一步抛错都进 catch 做 best-effort 回滚，再把原始错误抛回
// 权衡：单函数串行写库放弃并行，换取回滚账本的顺序可解释
export async function persistCompactSummary(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  content: string,
  summary: string,
  compactBoundary: CompactBoundaryPayload,
  traceContext: TraceContext,
  options?: {
    model?: Model;
    operationId?: string;
    postCompactReminderEntries?: readonly RuntimeMessageEntry[];
  },
): Promise<void> {
  // 没有 sessionStore 时摘要无法成为 durable 事实，调用方应在配置 store 后才进入 compact。
  if (!this.sessionStore) return;

  const created = Date.now();
  const persistedModel = resolvePersistedReminderModel(this, options?.model);
  // compact summary 和后续 reminder 是同一次历史替换；任一步失败都要一起回滚。
  // 回滚账本初值是主消息 id：它在第一段写入前就已确定，先登记避免漏删
  // 后续只追加 reminder 落库返回的非空 id，未落库的不入账
  // 顺序即写入顺序，回滚按登记顺序删除，依赖关系保证先建的先删
  // 账本不跨调用共享：每次 compact 提交独立记账，避免误删上一次的消息
  const persistedMessageIds: MessageId[] = [messageID];
  try {
    await this.persistMessage(
      {
        id: messageID,
        sessionID: this.sessionId,
        role: "user",
        time: {
          created,
        },
        summary: {
          title: "Compact summary",
          body: summary,
          diffs: [],
        },
        agent: this.config.agentName ?? "zcode-agent",
        modelSelection: persistedModel,
        // summary 消息对 UI/transcript 隐藏，但必须对 provider 可见；
        // 否则压缩后模型看不到摘要，等于历史被凭空截断（链路 4）。
        semantics: {
          origin: "agent_runtime",
          kind: "compact_summary",
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
        system: this.config.systemPrompt,
        tools: Object.fromEntries(this.getTools().map((tool) => [tool.name, true])),
      },
      traceContext,
    );
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "text",
        text: content,
        synthetic: true,
        time: {
          start: created,
          end: created,
        },
      },
      traceContext,
    );
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "compaction",
        auto: compactBoundary.trigger === "auto",
        trigger: compactBoundary.trigger,
        phase: compactBoundary.phase,
        compactReason: compactBoundary.compactReason,
        tail_start_id: compactBoundary.lastSummarizedMessageId,
        compactBoundary,
        operationId: options?.operationId,
      },
      traceContext,
    );
    // reminder 是压缩后必须重建的上下文前缀；只把真正落库的消息 id 记入回滚账本。
    for (const entry of options?.postCompactReminderEntries ?? []) {
      const reminderMessageId = await persistRuntimeReminderMessage.call(
        this,
        entry,
        traceContext,
        {
          created,
          model: options?.model,
        },
      );
      if (reminderMessageId) persistedMessageIds.push(reminderMessageId);
    }
  } catch (error) {
    // 回滚是 best-effort：清理失败也不能吞掉原始错误，compact 失败必须让上层决定重试或终止。
    await removeRuntimePersistenceMessagesBestEffort.call(this, persistedMessageIds, traceContext);
    throw error;
  }
}
