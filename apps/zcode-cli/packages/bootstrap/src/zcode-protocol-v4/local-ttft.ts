import { observeLocalTtftCompaction } from "./local-ttft-compaction.js";
import { LocalTtftClockWatch } from "./local-ttft-clock.js";
import {
  SessionEventType,
  observeLocalTurnPreparation,
  type SessionEvent,
  type ModelStreamingPayload,
  type ModelNetworkStatusPayload,
  type TurnStartedPayload,
  type TurnSteerQueuedPayload,
  type TurnSteerDrainedPayload,
  type TurnSteerDiscardedPayload,
} from "@zcode/contracts";
import {
  ConversationTelemetryFactNormalizer,
  streamingParentToolCallId,
} from "./conversation-telemetry-facts.js";
import { randomUUID } from "node:crypto";
import {
  LOCAL_TTFT_MAX_PENDING,
  LOCAL_TTFT_MAX_DETAILS,
  LOCAL_TTFT_TTL_MS,
  localTtftNow,
  type CommandEnvelope,
  type ConversationTelemetryFact,
  type LocalTtftFacts,
  type LocalTtftOutputKind,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 本地 TTFT（首 token 时延）观测记录器：按 commandId 跟踪一次输入从准入到首输出的时间线。
 *
 * 数据口径：只记录诊断事实（receivedAt、admittedAt、executionAt、requestAt、outputAt 与
 * attempt/retry/compaction 明细），不改写任何产品状态、不参与命令 admission、不建立第二份
 * accepted input 队列；输入事实只跟随 inbox 回调与 live SessionEvent。
 * 输出口径：每次变化经 checkpoint 回调（由上层决定如何聚合/落盘），并维护单调 revision。
 * 失败与降级：回调异常被吞掉，观测失败不阻塞主链路；超容量/TTL/时钟不可信只丢诊断记录；
 * 明细条数有界（超限置 truncated），completed 保留最近 N 条。
 * 不变量：同一 commandId 只接受一条记录；sendMode 单向 queued→guided，terminal 后 retire。
 */

/** 无业务裁决权：只跟随 inbox 和 live event，不建立第二份 accepted input queue。 */
export class LocalTtftRecorder {
  readonly instanceId = randomUUID();
  private clockWatch?: LocalTtftClockWatch;
  private readonly preparationSubscriptions = new Map<string, () => void>();
  private readonly normalizer = new ConversationTelemetryFactNormalizer();
  private readonly requestState = new Map<string, "response" | "preparation" | "failed">();
  private readonly queueSources = new Map<string, string>();
  private readonly checkpointSignatures = new Map<string, string>();
  private readonly completed = new Map<string, LocalTtftFacts>();
  private readonly records = new Map<string, LocalTtftFacts>();
  constructor(
    private readonly now: () => number = localTtftNow,
    private readonly onDrop: () => void = () => {},
    private readonly onCheckpoint: (facts: LocalTtftFacts) => void = () => {},
  ) {}

  /**
   * 输入准入登记：为带 ttft 元数据的命令创建初始记录。
   *
   * 输入：命令信封与 busy（决定 sendMode = queued/idle）。输出：true = 接受或已存在
   * （幂等），false = 待处理记录已达 LOCAL_TTFT_MAX_PENDING，调用方应视为放弃观测而非拒绝命令。
   * 副作用：写入内存记录、建立 turn preparation 订阅、必要时启动时钟看门狗；不写库、不广播帧。
   * 失败/降级：缺 ttft 元数据或重复 commandId 直接返回 true，不创建第二条记录。
   */
  receive(envelope: CommandEnvelope, busy: boolean): boolean {
    this.prune();
    if (
      !envelope.ttft ||
      this.records.has(envelope.commandId) ||
      this.completed.has(envelope.commandId)
    )
      return true;
    if (this.records.size >= LOCAL_TTFT_MAX_PENDING) return false;
    this.records.set(envelope.commandId, {
      ...envelope.ttft,
      instanceId: this.instanceId,
      commandId: envelope.commandId,
      ...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}),
      receivedAt: this.now(),
      sendMode: busy ? "queued" : "idle",
      details: [],
    });
    this.clockWatch ??= new LocalTtftClockWatch(this.now, (unreliable) => {
      if (unreliable)
        for (const record of this.records.values()) {
          if (record.outputAt === undefined) {
            record.clockInvalid = true;
            this.checkpoint(record);
          }
        }
      this.prune();
      if (!this.records.size) {
        this.clockWatch?.dispose();
        this.clockWatch = undefined;
      }
    });
    this.preparationSubscriptions.set(
      envelope.commandId,
      observeLocalTurnPreparation(envelope.commandId, (fact) => {
        const record = this.records.get(envelope.commandId);
        if (
          !record ||
          (record.sessionId && record.sessionId !== fact.sessionId) ||
          (record.turnId && record.turnId !== fact.turnId)
        )
          return;
        record.sessionId = fact.sessionId;
        record.turnId = fact.turnId;
        if (fact.stage === "execution") record.executionAt ??= fact.start;
        else {
          const details = (record.details ??= []);
          const index = details.findIndex((detail) => detail.id === fact.id);
          const detail = {
            id: fact.id,
            stage: fact.stage,
            start: fact.start,
            end: fact.end,
            outcome: fact.outcome,
            source: "cli" as const,
          };
          if (index >= 0) details[index] = detail;
          else if (details.length < LOCAL_TTFT_MAX_DETAILS) details.push(detail);
          else record.truncated = true;
        }
        this.checkpoint(record);
      }),
    );
    return true;
  }
  /**
   * 把当前记录快照推给上层，并保证 revision 严格递增。
   *
   * 口径：用忽略 revision 的 JSON 签名做去重，内容没变就不回调、不推进 revision；
   * 回调收到的是深拷贝 details，避免上层持有可变引用。
   * 失败/降级：回调异常在此吞掉（注释见实现），观测导出失败不得影响用户任务。
   */
  private checkpoint(record: LocalTtftFacts): void {
    const signature = JSON.stringify({ ...record, revision: undefined });
    if (this.checkpointSignatures.get(record.commandId) === signature) return;
    this.checkpointSignatures.set(record.commandId, signature);
    record.revision = (record.revision ?? 0) + 1;
    try {
      this.onCheckpoint({ ...record, details: record.details?.map((detail) => ({ ...detail })) });
    } catch {
      /* 导出不可影响业务。 */
    }
  }
  /**
   * 标记命令已被 CommandInbox 正式接纳：写入 admittedAt 并触发 checkpoint。
   * 只记录首个接纳时刻（??= 幂等），重复调用不改变时间线；找不到记录时静默忽略。
   */
  admitted(commandId: string): void {
    const record = this.records.get(commandId);
    if (record) {
      record.admittedAt ??= this.now();
      this.checkpoint(record);
    }
  }
  /**
   * 消费一条 live SessionEvent，把它折算进对应 command 的时间线。
   *
   * 处理顺序：先做 steer 队列状态迁移，再观察 compact 生命周期，然后把事件归一成
   * ConversationTelemetryFact（attempt/retry/usage 等），最后识别首个可见输出。
   * 输出判定口径：只有本轮主模型流的非空 text/reasoning/tool 增量（或顶层工具调度）
   * 才算首输出；子工具（parentToolCallId 非空）与空 delta 被忽略。
   * 副作用：仅内存状态与 checkpoint；无记录时立即返回，避免空转归一化。
   */
  event(sessionId: string, event: SessionEvent): void {
    if (!this.records.size) return;
    this.queueEvent(sessionId, event);
    if (
      event.type === SessionEventType.CompactStarted ||
      event.type === SessionEventType.CompactCompleted ||
      event.type === SessionEventType.CompactFailed
    ) {
      const current = this.forSession(sessionId);
      if (current && observeLocalTtftCompaction(current, event, this.now()))
        this.checkpoint(current);
    }
    const fact = this.normalizer.normalize(sessionId, event);
    if (fact)
      this.fact(
        fact,
        event.type === SessionEventType.TurnStarted
          ? (event.payload as TurnStartedPayload).executionStartedAt
          : undefined,
      );
    if (event.type === SessionEventType.ModelNetworkStatus) {
      const payload = event.payload as ModelNetworkStatusPayload;
      const record = this.forSession(sessionId);
      if (record && payload.modelCall) {
        if (record.requestId === payload.requestId)
          record.logicalCallId = payload.modelCall.logicalCallId;
        const attempt = record.details?.find(
          (detail) => detail.requestId === payload.requestId && detail.stage === "attempt",
        );
        if (attempt) attempt.logicalCallId = payload.modelCall.logicalCallId;
        this.checkpoint(record);
      }
    }
    if (event.type === SessionEventType.ModelStreaming) {
      const payload = event.payload as ModelStreamingPayload;
      // 空 block/start 没有可展示内容；只接受本轮主模型流中的非空增量。
      if (streamingParentToolCallId(event.payload as Record<string, unknown>)) return;
      if (payload.kind === "tool_call" && payload.toolName?.trim()) {
        this.output(sessionId, event.turnId ? String(event.turnId) : undefined, "tool");
        return;
      }
      if (!payload.delta?.trim()) return;
      const kind =
        payload.kind === "text_delta"
          ? "text"
          : payload.kind === "reasoning_delta"
            ? "reasoning"
            : payload.kind === "tool_input_delta"
              ? "tool"
              : undefined;
      if (kind) this.output(sessionId, event.turnId ? String(event.turnId) : undefined, kind);
    }
  }
  /**
   * 跟踪 steer（排队/引导）事件，把 pendingInputId 映射回原始 commandId。
   *
   * 口径：queued 只改 sendMode 并登记映射；drained 中 delivery=guide 视为 guided 并 retire；
   * discarded 中 reason=promoted 表示已转正、交给正式轮次继续跟踪（不 retire），
   * 其余按 turn_failed→failed、其它→cancelled 收口并 retire。
   * 失败/降级：映射缺失或 session 不匹配时静默跳过，不臆造归属；无 IO 副作用。
   */
  private queueEvent(sessionId: string, event: SessionEvent): void {
    if (event.type === SessionEventType.TurnSteerQueued) {
      const payload = event.payload as TurnSteerQueuedPayload;
      const commandId = payload.intent?.sourceCommandId ?? payload.inputId;
      const record = commandId ? this.records.get(commandId) : undefined;
      if (record && (!record.sessionId || record.sessionId === sessionId)) {
        record.sessionId = sessionId;
        record.sendMode = "queued";
        this.queueSources.set(payload.pendingInputId, record.commandId);
        this.checkpoint(record);
      }
    }
    if (event.type === SessionEventType.TurnSteerDrained) {
      const payload = event.payload as TurnSteerDrainedPayload;
      for (const input of payload.drainedInputs ?? []) {
        if (input.delivery !== "guide") continue;
        const commandId =
          input.intent?.sourceCommandId ?? this.queueSources.get(input.pendingInputId);
        const record = commandId ? this.records.get(commandId) : undefined;
        if (record?.sessionId === sessionId) {
          record.sendMode = "guided";
          this.checkpoint(record);
          this.retire(record);
        }
      }
    }
    if (event.type === SessionEventType.TurnSteerDiscarded) {
      const payload = event.payload as TurnSteerDiscardedPayload;
      if (payload.reason === "promoted") return;
      for (const id of payload.pendingInputIds) {
        const commandId = this.queueSources.get(id);
        const record = commandId ? this.records.get(commandId) : undefined;
        if (record?.sessionId === sessionId) {
          record.terminal = payload.reason === "turn_failed" ? "failed" : "cancelled";
          this.checkpoint(record);
          this.retire(record);
        }
      }
    }
  }
  /**
   * 把一条 telemetry fact 归约进对应 command 记录（TTFT 的核心状态机）。
   *
   * 归属口径：只认 sourceCommandId 命中且 session/turn 不冲突的事实；turn.started 锁定
   * sessionId/turnId，其余事实要求 turnId 一致，防止跨轮串数据。
   * 记录内容：model_request_* 维护 attempt 明细与 requestAt/requestId/model/provider；
   * retry_scheduled 记 retry_wait 并闭合同 role 的等待；tool scheduled 记首个 tool 输出；
   * turn.terminal 定终态并 retire。主轮 response 与 compact preparation 分开统计。
   * 失败/降级：非主轮/非 compact 的请求状态不参与首 token 判定；所有路径只触发内存 checkpoint。
   */
  fact(fact: ConversationTelemetryFact, executionStartedAt?: number): void {
    this.prune();
    const record = fact.sourceCommandId ? this.records.get(fact.sourceCommandId) : undefined;
    if (!record || (record.sessionId && record.sessionId !== fact.sessionId)) return;
    if (fact.kind === "turn.started") {
      record.sessionId = fact.sessionId;
      record.turnId = fact.turnId;
      record.executionAt ??= executionStartedAt;
      this.checkpoint(record);
      return;
    }
    if (record.turnId === undefined && fact.kind === "turn.terminal") record.turnId = fact.turnId;
    if (record.turnId !== fact.turnId) return;
    if (fact.kind === "model.request.status" && record.outputAt === undefined) {
      if (fact.querySource !== "main_turn" && fact.querySource !== "compact") return;
      const role = fact.querySource === "main_turn" ? "response" : "preparation";
      const details = (record.details ??= []);
      const id = `attempt:${fact.requestId}`;
      let attempt = details.find((detail) => detail.id === id);
      if (fact.status === "model_request_started" && !attempt) {
        this.requestState.set(record.commandId, role);
        if (details.length < LOCAL_TTFT_MAX_DETAILS) {
          attempt = {
            id,
            stage: "attempt",
            start: this.now(),
            requestId: fact.requestId,
            role,
            source: "cli",
          };
          details.push(attempt);
        } else record.truncated = true;
        for (const wait of details)
          if (wait.stage === "retry_wait" && wait.end === undefined && wait.role === role) {
            wait.end = this.now();
            wait.outcome = "completed";
          }
        if (role === "response") {
          record.requestAt ??= this.now();
          record.queryId ??= fact.queryId;
          record.requestId = fact.requestId;
          record.model = fact.modelId.slice(0, 128);
          record.provider = fact.providerId.slice(0, 128);
        }
      }
      if (
        (fact.status === "model_request_failed" || fact.status === "model_request_completed") &&
        attempt &&
        attempt.end === undefined
      ) {
        attempt.end = this.now();
        attempt.outcome = fact.status === "model_request_failed" ? "failed" : "completed";
        if (
          role === "response" &&
          fact.status === "model_request_failed" &&
          record.requestId === fact.requestId
        )
          this.requestState.set(record.commandId, "failed");
      }
      if (
        fact.status === "model_retry_scheduled" &&
        !details.some((detail) => detail.id === `retry:${fact.requestId}`)
      ) {
        if (details.length < LOCAL_TTFT_MAX_DETAILS)
          details.push({
            id: `retry:${fact.requestId}`,
            stage: "retry_wait",
            start: this.now(),
            requestId: fact.requestId,
            role,
            source: "cli",
          });
        else record.truncated = true;
      }
    }
    this.checkpoint(record);
    if (fact.kind === "tool.lifecycle" && fact.phase === "scheduled" && !fact.parentToolCallId)
      this.output(fact.sessionId, fact.turnId, "tool");
    if (fact.kind === "turn.terminal") {
      record.terminal =
        fact.status === "success" ? "completed" : fact.status === "failed" ? "failed" : "cancelled";
      this.checkpoint(record);
      this.retire(record);
    }
  }
  /**
   * 记录本轮首个可见输出（text/reasoning/tool），只在尚未 outputAt 时写入。
   *
   * 前置：必须已有 requestAt（首 token 从主请求发出起算），且该 command 不处于
   * preparation（compact 预处理）或已 failed 状态，避免把压缩/失败请求的流算成首 token。
   * 副作用：写 outputAt/outputKind、闭合 attempt 明细的 first_output、退订 preparation；
   * text 输出后立即 retire。未命中任何记录时无操作。
   */
  output(sessionId: string, turnId: string | undefined, kind: LocalTtftOutputKind): void {
    for (const record of this.records.values()) {
      if (
        this.requestState.get(record.commandId) === "failed" ||
        this.requestState.get(record.commandId) === "preparation"
      )
        continue;
      if (
        record.sessionId === sessionId &&
        record.turnId === turnId &&
        record.requestAt !== undefined &&
        record.outputAt === undefined
      ) {
        record.outputAt = this.now();
        record.outputKind = kind;
        this.preparationSubscriptions.get(record.commandId)?.();
        this.preparationSubscriptions.delete(record.commandId);
        const attempt = record.details?.find(
          (detail) => detail.id === `attempt:${record.requestId}`,
        );
        if (attempt && attempt.end === undefined) {
          attempt.end = record.outputAt;
          attempt.outcome = "first_output";
        }
      }
      if (
        record.sessionId === sessionId &&
        record.turnId === turnId &&
        record.requestAt !== undefined &&
        kind === "text"
      )
        this.retire(record);
    }
  }
  /**
   * 收口一条记录：清理该 command 的订阅/映射，移出活跃表并放入有界 completed 表。
   *
   * 口径：completed 超过 LOCAL_TTFT_MAX_PENDING 时按插入序淘汰最旧一条，
   * 并调用 onDrop 让上层知道诊断样本被丢弃。无活跃记录时顺带停掉时钟看门狗。
   * 失败/降级：onDrop 异常被吞掉，丢弃诊断不影响用户任务；retire 对同一记录非幂等，
   * 调用方需保证只在命中活跃表时调用。
   */
  private retire(record: LocalTtftFacts): void {
    // 首正文/terminal 后不再归一逐 token 事件；保留有界末态供实际帧扇出。
    this.forget(record.commandId);
    this.records.delete(record.commandId);
    if (!this.records.size) {
      this.clockWatch?.dispose();
      this.clockWatch = undefined;
    }
    this.completed.set(record.commandId, record);
    if (this.completed.size > LOCAL_TTFT_MAX_PENDING) {
      this.completed.delete(this.completed.keys().next().value!);
      try {
        this.onDrop();
      } catch {
        /* 丢弃诊断不能影响用户任务。 */
      }
    }
  }
  /**
   * 按 session 查最近一条记录（先 completed 后活跃，倒序取第一条）。
   *
   * 口径：指定 commandId 时必须精确命中；未指定时只返回已绑定 turnId 的记录，
   * 避免把尚未开始执行的输入当成当前轮。返回的是内部对象引用，仅供只读观测。
   * 副作用：查询前顺带 prune（可能淘汰过期记录并触发 forget）。
   */
  forSession(sessionId: string, commandId?: string): LocalTtftFacts | undefined {
    this.prune();
    return [...this.completed.values(), ...this.records.values()]
      .reverse()
      .find(
        (record) =>
          record.sessionId === sessionId &&
          (commandId ? record.commandId === commandId : record.turnId !== undefined),
      );
  }
  /**
   * 清空全部诊断状态：停表、退订 preparation、清记录/映射/签名/completed。
   * 用于网关 dispose 或 session 生命周期结束；不通知 onDrop，也不产生任何 checkpoint。
   */
  clear(): void {
    this.clockWatch?.dispose();
    this.clockWatch = undefined;
    for (const off of this.preparationSubscriptions.values()) off();
    this.preparationSubscriptions.clear();
    this.records.clear();
    this.requestState.clear();
    this.queueSources.clear();
    this.checkpointSignatures.clear();
    this.completed.clear();
  }
  /**
   * 删除某 command 的旁路状态：preparation 订阅、requestState、checkpoint 签名、
   * 以及 pendingInputId → commandId 的 queue 映射。
   * retire 与 prune 共用；对不存在的 command 幂等。
   */
  private forget(commandId: string): void {
    this.preparationSubscriptions.get(commandId)?.();
    this.preparationSubscriptions.delete(commandId);
    this.requestState.delete(commandId);
    this.checkpointSignatures.delete(commandId);
    for (const [id, source] of this.queueSources)
      if (source === commandId) this.queueSources.delete(id);
  }
  /**
   * 按 receivedAt 做 TTL 淘汰（活跃与 completed 都适用）。
   * 过期记录先 forget 再删除，避免订阅/映射泄漏；不触发 onDrop。
   */
  private prune(): void {
    const now = this.now();
    for (const records of [this.records, this.completed])
      for (const [key, record] of records)
        if (now - record.receivedAt > LOCAL_TTFT_TTL_MS) {
          this.forget(key);
          records.delete(key);
        }
  }
}
