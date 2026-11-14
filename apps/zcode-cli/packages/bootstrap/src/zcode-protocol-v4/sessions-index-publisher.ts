// sessions-index topic publisher：在 SessionsIndexProjection 之上做
// seq 区间记账 + snapshot/delta 帧构造 + 每连接单订阅（重订阅替换旧代际）。
// 比 ConversationTopicPublisher 简单：index delta 不做 profile 过滤（列表摘要对所有客户端一致），
// conflation 已在 projection 内完成（同 sessionId 覆盖）；重放缓冲有界，
// 溢出/断档退化为 snapshot（conflated 语义下与续传等价）。
// 本类的 seq 只属于 sessions-index topic，与 conversation topic 的 seq/logEpoch 各自独立；
// 订阅帧的 (fromSeq,toSeq] 覆盖所有已记账 delta（包括被 profile/编码过滤掉的部分）。
import type {
  ConversationSnapshot,
  SessionsIndexDelta,
  SessionsIndexTopicFrame,
  TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { sessionsIndexTopic } from "@zcode/shared/zcode-protocol-v4";
import {
  SessionsIndexProjection,
  type SessionSummaryDeriveExtra,
} from "./sessions-index-projection.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

interface IndexSubscription {
  subscriptionId: string;
  connectionId: string;
  /** 下一帧 fromSeq（(fromSeq, toSeq] 语义）。 */
  sentSeq: number;
  inFlight: TopicFrameReservation<SessionsIndexTopicFrame> | null;
  nextLogicalFrameOrdinal: number;
}

export interface SessionsIndexSubscribeResult {
  subscriptionId: string;
  mode: "snapshot" | "resume";
  frame: SessionsIndexTopicFrame | null;
  reservation: TopicFrameReservation<SessionsIndexTopicFrame> | null;
  rollback(): boolean;
}

interface SessionsIndexResyncRequest {
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}

/**
 * sessions-index topic 的传输权威：持有 projection、单调 seq、有界重放日志与每连接订阅。
 *
 * 输入：会话级 ConversationSnapshot（经 projection 归约成 upsert/remove）与订阅时的
 * base{logEpoch,seq}；输出：SubscribeAck + 可选 reservation（snapshot 或续传 delta 帧）。
 * 副作用：只做内存记账与帧构造，不做网络 IO；flush 时机由 gateway/host 驱动。
 * 失败与降级：重放缓冲溢出/seq 断档 → 用当前全量 snapshot 代替（conflated 语义下等价）；
 * 每连接单订阅，重订阅替换旧代际，迟到 commit/rollback 因身份不匹配而失败关闭。
 * 不变量：seq 单调递增；snapshot.toSeq 等于记账水位；frame.fromSeq 精确等于订阅已提交水位。
 */
export class SessionsIndexPublisher {
  private readonly projection: SessionsIndexProjection;
  private currentSeq = 0;
  /** (seq, delta) 有界重放缓冲：仅保留最近若干帧供 resume；溢出退化为 snapshot。 */
  private readonly deltaLog: Array<{ seq: number; delta: SessionsIndexDelta }> = [];
  private readonly maxDeltaLog = 512;
  private readonly subscriptions = new Map<string, IndexSubscription>();
  private readonly subscriptionIdByConnection = new Map<string, string>();
  private nextSubscriptionSerial = 1;
  private nextLogicalFrameSerial = 1;

  /**
   * 建立某 workspace 的索引权威。seq 从 0 起、重放日志为空；now 只用于 frame.sentAt。
   * workspaceId/logEpoch 一经构造不可变，跨代际恢复由客户端比对这两个值决定是否全量重拉。
   */
  constructor(
    readonly workspaceId: string,
    readonly logEpoch: string,
    private readonly now: () => number = Date.now,
  ) {
    this.projection = new SessionsIndexProjection(workspaceId, logEpoch);
  }

  /** sessions-index topic 固定标识（由 topicForWorkspace 构造）；只读。 */
  private get topic(): string {
    return sessionsIndexTopic(this.workspaceId);
  }

  /** 冷启动种子：直接放入一条已知 summary（store 会话，无 live projection）。 */
  // 不推进 seq、不产 delta；必须在首个订阅/首次 snapshot 前完成，否则会与 live 状态竞态。
  seed(summary: Parameters<SessionsIndexProjection["seed"]>[0]): void {
    this.projection.seed(summary);
  }

  /** 迁移重读：补齐首次冷种子缺失的 store 摘要，并为在线订阅产生正常 delta。 */
  // 已存在的 summary 不会被冷存储覆盖（insertSeedIfMissing 幂等）；返回是否真正产生 delta。
  mergeMissingStoredSummaries(
    summaries: readonly Parameters<SessionsIndexProjection["seed"]>[0][],
  ): boolean {
    return this.record(
      summaries.flatMap((summary) => this.projection.insertSeedIfMissing(summary)),
    );
  }

  /** 某会话最新快照进入 → 更新 summary，产生的 delta 记账并推进 seq。返回是否有变化。 */
  // 变化判定完全由 projection 的 conflation 决定；无变化时不推进 seq，也不广播帧。
  ingestConversation(
    snapshot: ConversationSnapshot,
    extra: Omit<SessionSummaryDeriveExtra, "workspaceId">,
  ): boolean {
    return this.record(this.projection.upsertFromConversation(snapshot, extra));
  }

  /** 会话移除 → remove delta 记账。返回是否有变化。 */
  // 仅当 projection 中确实存在该 sessionId 时才产出 delta；重复移除不推进 seq。
  removeSession(sessionId: string): boolean {
    return this.record(this.projection.remove(sessionId));
  }

  /**
   * 把 projection 产出的 delta 写入有界重放日志并推进 seq。
   *
   * 口径：每条 delta 独立占一个 seq（同批多条按顺序递增）；日志超过 maxDeltaLog(512)
   * 时丢弃最旧条目，后续 resume 若起始 seq 已被丢弃则退化为 snapshot。
   * 返回 false 表示无 delta、未推进 seq；不触发任何广播（fan-out 由 gateway 调度）。
   */
  private record(deltas: SessionsIndexDelta[]): boolean {
    if (deltas.length === 0) return false;
    for (const delta of deltas) {
      this.currentSeq += 1;
      this.deltaLog.push({ seq: this.currentSeq, delta });
    }
    while (this.deltaLog.length > this.maxDeltaLog) this.deltaLog.shift();
    return true;
  }

  /**
   * 当前记账水位（最近一次真实变化的 seq）。只读；snapshot.toSeq 与订阅可续区间都以它为界。
   */
  get seq(): number {
    return this.currentSeq;
  }

  /** 订阅：base 有效且可续传则 resume，否则 snapshot。每连接单订阅（替换旧代际）。 */
  // 便捷入口：立即 commit reservation（等价于本地 transport 已接受）。生产 gateway 应使用
  // subscribeReserved，等物理批次全部接受后再 commit。
  // 返回值含 ack{mode,logEpoch}、可选 reservation 与 rollback；无新增时 frame 为 null。
  subscribe(
    connectionId: string,
    base?: { logEpoch: string; seq: number },
  ): SessionsIndexSubscribeResult {
    const result = this.subscribeReserved(connectionId, base);
    result.reservation?.commit();
    return result;
  }

  /**
   * 生产入口：先替换旧订阅并预留首帧，由调用方在物理投递成功后 commit。
   *
   * 裁决口径：base.logEpoch 必须匹配本代际，且 base.seq 落在重放日志可连续覆盖的区间；
   * 否则回 snapshot（fromSeq=0，toSeq=当前水位）。base.seq 等于当前水位时不产帧。
   * 失败/降级：rollback 只在首帧尚未 commit 且订阅身份仍匹配时恢复上一代订阅；
   * 任何迟到回滚一律返回 false，避免撤销已被接受的替换。
   */
  subscribeReserved(
    connectionId: string,
    base?: { logEpoch: string; seq: number },
  ): SessionsIndexSubscribeResult {
    const previousId = this.subscriptionIdByConnection.get(connectionId);
    const previousSubscription = previousId ? this.subscriptions.get(previousId) : undefined;
    if (previousId) this.subscriptions.delete(previousId);
    const subscriptionId = `six-${this.logEpoch}-${this.nextSubscriptionSerial++}`;
    const subscription: IndexSubscription = {
      subscriptionId,
      connectionId,
      sentSeq: 0,
      inFlight: null,
      nextLogicalFrameOrdinal: 1,
    };
    this.subscriptions.set(subscriptionId, subscription);
    this.subscriptionIdByConnection.set(connectionId, subscriptionId);
    const rollback = (): boolean => {
      if (
        subscription.inFlight === null ||
        this.subscriptions.get(subscriptionId) !== subscription ||
        this.subscriptionIdByConnection.get(connectionId) !== subscriptionId
      ) {
        return false;
      }
      this.subscriptions.delete(subscriptionId);
      if (previousId && previousSubscription) {
        this.subscriptions.set(previousId, previousSubscription);
        this.subscriptionIdByConnection.set(connectionId, previousId);
      } else {
        this.subscriptionIdByConnection.delete(connectionId);
      }
      return true;
    };

    // resume：base 同代际 + seq 落在重放缓冲区间内。
    const canResume =
      base !== undefined &&
      base.logEpoch === this.logEpoch &&
      this.canResumeFrom(base.seq);
    if (canResume) {
      subscription.sentSeq = base.seq;
      const reservation =
        base.seq === this.currentSeq ? null : this.reserveDeltaFrame(subscription, "initial");
      return this.subscribeResult(
        subscriptionId,
        "resume",
        reservation,
        reservation ? rollback : () => false,
      );
    }
    const reservation = this.reserveFrame(
      subscription,
      this.snapshotFrame(subscriptionId),
      "initial",
    );
    return this.subscribeResult(subscriptionId, "snapshot", reservation, rollback);
  }

  /** same-sub recovery：从客户端 base 重建，不信 sentSeq。 */
  // 客户端 base 是唯一恢复起点：先作废在途 reservation 与旧缓冲，再按 base 决定 resume/snapshot。
  // forceSnapshot=true 时无条件回全量；旧 sentSeq/inFlight 仅作为 rollback 的恢复目标。
  // 输出新 reservation 与回滚函数；订阅不存在时返回 null。
  resyncReserved(
    subscriptionId: string,
    request: SessionsIndexResyncRequest,
  ): SessionsIndexSubscribeResult | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;
    const previous = { sentSeq: subscription.sentSeq, inFlight: subscription.inFlight };
    subscription.inFlight = null;
    const base = request.base;
    const canResume =
      !request.forceSnapshot &&
      base !== null &&
      base.logEpoch === this.logEpoch &&
      this.canResumeFrom(base.seq);
    if (canResume) {
      subscription.sentSeq = base.seq;
      const reservation =
        base.seq === this.currentSeq
          ? this.reserveFrame(subscription, {
              topic: this.topic,
              subscriptionId,
              fromSeq: base.seq,
              toSeq: base.seq,
              sentAt: this.now(),
              payload: { kind: "deltas", deltas: [] },
            }, "recovery")
          : this.reserveDeltaFrame(subscription, "recovery");
      return this.subscribeResult(
        subscriptionId,
        "resume",
        reservation,
        this.resyncRollback(subscription, reservation, previous),
      );
    }
    subscription.sentSeq = 0;
    const reservation = this.reserveFrame(
      subscription,
      this.snapshotFrame(subscriptionId),
      "recovery",
    );
    return this.subscribeResult(
      subscriptionId,
      "snapshot",
      reservation,
      this.resyncRollback(subscription, reservation, previous),
    );
  }

  /**
   * recovery 的回滚：仅当 reservation 仍是该订阅当前在途帧时，恢复之前的 sentSeq/inFlight。
   * 已被新 recovery 取代或订阅被删除时返回 false（迟到回滚不得覆盖新状态）。
   */
  private resyncRollback(
    subscription: IndexSubscription,
    reservation: TopicFrameReservation<SessionsIndexTopicFrame>,
    previous: Pick<IndexSubscription, "sentSeq" | "inFlight">,
  ): () => boolean {
    return (): boolean => {
      if (
        this.subscriptions.get(subscription.subscriptionId) !== subscription ||
        subscription.inFlight !== reservation
      ) {
        return false;
      }
      subscription.sentSeq = previous.sentSeq;
      subscription.inFlight = previous.inFlight;
      return true;
    };
  }

  /**
   * 判断某 seq 能否无损续传。
   *
   * 口径：seq 必须在 [0, currentSeq]；等于当前水位天然可续（无增量）；
   * 否则重放日志中第一个大于 seq 的条目必须恰为 seq+1，证明区间连续、未被淘汰。
   * 越界或断档返回 false，调用方退化为 snapshot。
   */
  private canResumeFrom(seq: number): boolean {
    if (seq < 0 || seq > this.currentSeq) return false;
    if (seq === this.currentSeq) return true;
    const firstPending = this.deltaLog.find((entry) => entry.seq > seq);
    return firstPending?.seq === seq + 1;
  }

  /**
   * 取消订阅并清 connection→subscription 归属。
   *
   * 传入 connectionId 时做归属校验，不匹配则忽略（防止跨连接误删）；
   * 只清 registry，不发送任何帧，也不影响其它仍存活的订阅。
   */
  unsubscribe(subscriptionId: string, connectionId?: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    if (connectionId !== undefined && subscription.connectionId !== connectionId) {
      return;
    }
    this.subscriptions.delete(subscriptionId);
    if (this.subscriptionIdByConnection.get(subscription.connectionId) === subscriptionId) {
      this.subscriptionIdByConnection.delete(subscription.connectionId);
    }
  }

  /**
   * 订阅是否存在；传入 connectionId 时同时校验归属。
   * 只读查询，供 gateway 在 dispose/路由时确认帧落点。
   */
  hasSubscription(subscriptionId: string, connectionId?: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    return Boolean(
      subscription && (connectionId === undefined || subscription.connectionId === connectionId),
    );
  }

  /**
   * 构造全量 snapshot 帧：fromSeq=0，toSeq=当前记账水位，payload 为 projection 的完整摘要集合。
   * 不推进 sentSeq（由 reservation.commit 统一推进），也不清订阅缓冲。
   */
  private snapshotFrame(subscriptionId: string): SessionsIndexTopicFrame {
    return {
      topic: this.topic,
      subscriptionId,
      fromSeq: 0,
      toSeq: this.currentSeq,
      sentAt: this.now(),
      payload: { kind: "snapshot", snapshot: this.projection.getSnapshot() },
    };
  }

  /** 排出某订阅未发的增量帧；无增量返回 null。 */
  // 便捷入口：reserve 后立即 commit；生产 gateway 应持有 reservation，等物理投递成功再 commit。
  flush(subscriptionId: string): SessionsIndexTopicFrame | null {
    const reservation = this.reserveFlush(subscriptionId);
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  /**
   * 为订阅预留下一帧：已有在途帧则复用同一 reservation（保持 logical frame 顺序）；
   * 水位已对齐返回 null；否则按 deltaLog 生成 deltas 帧（断档时退化为 snapshot）。
   * 只读订阅状态，不 commit、不推进 sentSeq；重复调用在没有新 delta 时稳定返回同一结果。
   */
  reserveFlush(subscriptionId: string): TopicFrameReservation<SessionsIndexTopicFrame> | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;
    if (subscription.inFlight) return subscription.inFlight;
    if (subscription.sentSeq >= this.currentSeq) return null;
    return this.reserveDeltaFrame(subscription);
  }

  /**
   * 生成 (sentSeq, currentSeq] 的增量帧；若重放日志已丢弃该起点（seq 断档）则改用 snapshot。
   * 输出是未提交 reservation：payload 固定为当时快照，之后新增的 delta 留给下一帧。
   * 不修改 sentSeq，保证 commit 前重复 reserve 不会造成跳号。
   */
  private reserveDeltaFrame(
    subscription: IndexSubscription,
    deliveryKind: TopicFrameDeliveryKind = "online",
  ): TopicFrameReservation<SessionsIndexTopicFrame> {
    const pending = this.deltaLog.filter((entry) => entry.seq > subscription.sentSeq);
    // 重放缓冲已丢弃部分区间（seq 断档）→ 退化为 snapshot（conflated 语义下等价）。
    if (pending.length === 0 || pending[0]!.seq !== subscription.sentSeq + 1) {
      return this.reserveFrame(
        subscription,
        this.snapshotFrame(subscription.subscriptionId),
        deliveryKind,
      );
    }
    const fromSeq = subscription.sentSeq;
    return this.reserveFrame(subscription, {
      topic: this.topic,
      subscriptionId: subscription.subscriptionId,
      fromSeq,
      toSeq: this.currentSeq,
      sentAt: this.now(),
      payload: { kind: "deltas", deltas: pending.map((entry) => entry.delta) },
    }, deliveryKind);
  }

  /**
   * 把帧包装成 reservation 并挂到订阅 inFlight。
   *
   * commit 语义：仅当订阅仍是同一对象且 inFlight 仍是本 reservation 时，把 sentSeq 推进到
   * frame.toSeq 并清空 inFlight；重复 commit 幂等返回 true；身份失配返回 false（迟到帧丢弃）。
   * 同时分配单调 logicalFrameId/Ordinal，供宿主按逻辑帧顺序投递与去重。
   */
  private reserveFrame(
    subscription: IndexSubscription,
    frame: SessionsIndexTopicFrame,
    deliveryKind: TopicFrameDeliveryKind,
  ): TopicFrameReservation<SessionsIndexTopicFrame> {
    let committed = false;
    const reservation: TopicFrameReservation<SessionsIndexTopicFrame> = {
      deliveryKind,
      logicalFrameId: `${subscription.subscriptionId}-lf-${this.nextLogicalFrameSerial++}`,
      logicalFrameOrdinal: subscription.nextLogicalFrameOrdinal++,
      frame,
      commit: () => {
        if (committed) return true;
        if (
          this.subscriptions.get(subscription.subscriptionId) !== subscription ||
          subscription.inFlight !== reservation
        ) {
          return false;
        }
        subscription.sentSeq = frame.toSeq;
        subscription.inFlight = null;
        committed = true;
        return true;
      },
    };
    subscription.inFlight = reservation;
    return reservation;
  }

  /**
   * 组装订阅结果：ack、reservation、rollback，以及兼容旧单测的 frame getter。
   * 注意 frame getter 会立即 commit；生产 gateway 只应读 reservation，避免绕过物理投递确认。
   */
  private subscribeResult(
    subscriptionId: string,
    mode: "snapshot" | "resume",
    reservation: TopicFrameReservation<SessionsIndexTopicFrame> | null,
    rollback: () => boolean,
  ): SessionsIndexSubscribeResult {
    return {
      subscriptionId,
      mode,
      reservation,
      rollback,
      get frame() {
        reservation?.commit();
        return reservation?.frame ?? null;
      },
    };
  }

  /**
   * 是否仍有订阅者。Resident 回收/workspace 去激活据此判断是否可释放 publisher；
   * 只读、无副作用。
   */
  hasSubscribers(): boolean {
    return this.subscriptions.size > 0;
  }

  /**
   * 当前全部订阅 ID 快照（含 in-flight 与已对齐水位的订阅）。
   * 供 gateway dispose/清理时遍历；返回副本，调用方增删不影响内部 Map。
   */
  subscriptionIds(): string[] {
    return [...this.subscriptions.keys()];
  }

  /**
   * 反查订阅所属 connectionId；不存在返回 null。
   * 用于帧路由到具体 attachment，不校验权限，鉴权在 host/connection 层完成。
   */
  connectionIdForSubscription(subscriptionId: string): string | null {
    return this.subscriptions.get(subscriptionId)?.connectionId ?? null;
  }
}
