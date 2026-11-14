// workspace-config topic publisher（v4 additive 新增）：workspace 级配置目录（config options +
// slash 命令目录）的 conflated 最新态 + seq 区间记账 + snapshot/delta 帧构造。
// 与 SessionsIndexPublisher 同构且更简单：载荷是单个整体替换态（config.updated），
// conflation = 深比较去抖；重放缓冲有界，断档退化为 snapshot（conflated 语义下等价）。
// 边界：状态是整体替换的 config.updated，没有逐字段 delta；每连接单订阅、按连接覆盖旧代际。
// 失败降级：replay 区间不连续或 base.logEpoch 不匹配时回全量 snapshot；dispose 不在本类，
// 由 gateway 删除 publisher 并通知客户端重新订阅。本类只做内存记账，无网络与持久化 IO。
import type {
  WorkspaceConfigDelta,
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
  TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { workspaceConfigTopic } from "@zcode/shared/zcode-protocol-v4";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

interface ConfigSubscription {
  subscriptionId: string;
  connectionId: string;
  /** 下一帧 fromSeq（(fromSeq, toSeq] 语义）。 */
  sentSeq: number;
  inFlight: TopicFrameReservation<WorkspaceConfigTopicFrame> | null;
  nextLogicalFrameOrdinal: number;
}

/**
 * 订阅结果：mode 表示本次裁决（resume=续传 delta，snapshot=全量重放）。
 * frame 为兼容旧调用方的即时 commit 便捷读口；生产 transport 应只用 reservation，
 * 等物理批次确认后再 commit，避免 ack 先于数据落地。rollback 仅撤销尚未 commit 的首帧。
 */
export interface WorkspaceConfigSubscribeResult {
  subscriptionId: string;
  mode: "snapshot" | "resume";
  frame: WorkspaceConfigTopicFrame | null;
  reservation: TopicFrameReservation<WorkspaceConfigTopicFrame> | null;
  rollback(): boolean;
}

/**
 * same-sub recovery 请求：base 为客户端已确认的最新位置，null 表示无可用基座；
 * forceSnapshot=true 时忽略 base 直接回全量（用于客户端检测到状态可能损坏）。
 */
interface WorkspaceConfigResyncRequest {
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}

/** 配置目录体量小、变更低频，深比较直接用稳定序列化（构建器输出字段顺序稳定）。 */
// 依赖字段顺序稳定；数组顺序变化视为真实变化。仅用于 publish 去抖，不参与 seq 记账。
// 等价时不得推进 seq 或广播帧。
function statesEqual(a: WorkspaceConfigState, b: WorkspaceConfigState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * workspace-config topic 的传输权威：整体替换态 + 单调 seq + 有界 delta 重放 + 每连接订阅。
 *
 * 输入：最新 WorkspaceConfigState、订阅请求 base{logEpoch,seq}、recovery 请求。
 * 输出：SubscribeAck(mode) + 可选首帧 reservation；delta 帧形如 config.updated 整态。
 * 副作用：只做内存记账（state/seq/deltaLog/subscriptions），flush 时机由 gateway 驱动。
 * 失败与降级：deltaLog 溢出或 base 无法连续覆盖时回 snapshot（conflated 语义下等价）；
 * 重订阅替换同 connection 的旧订阅；迟到 commit/rollback 因身份失配而失败关闭。
 * 不变量：seq 单调且每次真实变化 +1；frame.fromSeq 等于订阅已提交水位；toSeq=记账水位。
 */
export class WorkspaceConfigPublisher {
  private state: WorkspaceConfigState = { configOptions: [], slashCommands: [] };
  private currentSeq = 0;
  /** (seq, delta) 有界重放缓冲；溢出/断档退化为 snapshot。 */
  private readonly deltaLog: Array<{
    seq: number;
    delta: WorkspaceConfigDelta;
  }> = [];
  private readonly maxDeltaLog = 32;
  private readonly subscriptions = new Map<string, ConfigSubscription>();
  private readonly subscriptionIdByConnection = new Map<string, string>();
  private nextSubscriptionSerial = 1;
  private nextLogicalFrameSerial = 1;

  /**
   * 建立某 workspace 的配置权威。初始态为空目录（无 configOptions/slashCommands），seq=0。
   * workspaceId/logEpoch 不可变；now 只用于 frame.sentAt，便于测试注入。
   */
  constructor(
    readonly workspaceId: string,
    readonly logEpoch: string,
    private readonly now: () => number = Date.now,
  ) {}

  private get topic(): string {
    return workspaceConfigTopic(this.workspaceId);
  }

  /**
   * 返回当前 conflated 配置态（内部引用，只读使用）。
   * 不做深拷贝，调用方不得原地修改；并发 publish 会整体替换 state 引用。
   */
  getState(): WorkspaceConfigState {
    return this.state;
  }

  /** 最新配置目录进入 → conflated 去抖，变化则记账推进 seq。返回是否有变化。 */
  // 等价则不推进 seq、不产 delta，避免向全部订阅者广播空 config.updated。
  // 真实变化时整态替换并写一条 config.updated；deltaLog 超 32 条丢弃最旧，后续续传退 snapshot。
  publish(state: WorkspaceConfigState): boolean {
    if (statesEqual(this.state, state)) return false;
    this.state = state;
    this.currentSeq += 1;
    this.deltaLog.push({
      seq: this.currentSeq,
      delta: { op: "config.updated", config: state },
    });
    while (this.deltaLog.length > this.maxDeltaLog) this.deltaLog.shift();
    return true;
  }

  /**
   * 当前记账水位（已提交给客户端的最大 seq 由此推导）。
   * 只读；订阅帧的 toSeq 与 replay 的连续区间都以此为界。
   */
  get seq(): number {
    return this.currentSeq;
  }

  /** 订阅：base 有效且可续传则 resume，否则 snapshot。每连接单订阅（重订阅替换旧代际）。 */
  // 便捷入口：构造后立即 commit 首帧（等价本地 transport 已接受）；生产 gateway 用
  // subscribeReserved，等物理投递成功再 commit。connectionId 是订阅归属键，非鉴权凭据。
  // 返回 SubscribeAck 与 rollback；无新增（base.seq==水位）时 reservation/frame 为 null。
  subscribe(
    connectionId: string,
    base?: { logEpoch: string; seq: number },
  ): WorkspaceConfigSubscribeResult {
    const result = this.subscribeReserved(connectionId, base);
    result.reservation?.commit();
    return result;
  }

  /**
   * 生产订阅入口：先替换该连接旧订阅并预留首帧，由调用方在投递成功后 commit。
   *
   * 裁决：base.logEpoch 必须匹配本代际且 base.seq 可被 deltaLog 连续覆盖才 resume，
   * 否则 snapshot(fromSeq=0,toSeq=当前水位)。base.seq==currentSeq 时不产帧。
   * rollback：仅当首帧仍在途且订阅身份未变时恢复旧订阅（含旧 sentSeq/inFlight），
   * 否则返回 false，防止迟到回滚覆盖新代际。
   */
  subscribeReserved(
    connectionId: string,
    base?: { logEpoch: string; seq: number },
  ): WorkspaceConfigSubscribeResult {
    const previousId = this.subscriptionIdByConnection.get(connectionId);
    const previousSubscription = previousId ? this.subscriptions.get(previousId) : undefined;
    if (previousId) this.subscriptions.delete(previousId);
    const subscriptionId = `wcs-${this.logEpoch}-${this.nextSubscriptionSerial++}`;
    const subscription: ConfigSubscription = {
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
  // 先作废在途首帧，再按 base/forceSnapshot 重算 resume 或 snapshot；旧 sentSeq/inFlight
  // 只作为 rollback 恢复目标。base==currentSeq 时仍产一个空 deltas 帧，明确告诉客户端已对齐。
  // 订阅不存在返回 null；rollback 仅在本次 reservation 仍在途时生效。
  resyncReserved(
    subscriptionId: string,
    request: WorkspaceConfigResyncRequest,
  ): WorkspaceConfigSubscribeResult | null {
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
   * recovery 的回滚：只在本次 reservation 仍是订阅在途帧且订阅身份未变时，
   * 把 sentSeq/inFlight 恢复为 recovery 前的值；否则返回 false（已被新 recovery 取代）。
   * 不删除/重建订阅本身，避免影响其它操作已持有的引用。
   */
  private resyncRollback(
    subscription: ConfigSubscription,
    reservation: TopicFrameReservation<WorkspaceConfigTopicFrame>,
    previous: Pick<ConfigSubscription, "sentSeq" | "inFlight">,
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
   * seq 能否无损续传：必须在 [0,currentSeq]；等于水位天然可续；
   * 否则 deltaLog 中首个大于 seq 的条目必须恰为 seq+1（证明区间连续未被淘汰）。
   * 越界/断档返回 false，调用方退化为 snapshot。
   */
  private canResumeFrom(seq: number): boolean {
    if (seq < 0 || seq > this.currentSeq) return false;
    if (seq === this.currentSeq) return true;
    const firstPending = this.deltaLog.find((entry) => entry.seq > seq);
    return firstPending?.seq === seq + 1;
  }

  /**
   * 取消订阅并清理 connection→subscription 归属。
   * 传 connectionId 时校验归属，不匹配则忽略（防跨连接误删）；不发送帧、不影响其它订阅。
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
   * 订阅是否存在；传 connectionId 时同时校验归属。
   * 只读查询，供 gateway 在 dispose/路由时确认帧落点。
   */
  hasSubscription(subscriptionId: string, connectionId?: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    return Boolean(
      subscription && (connectionId === undefined || subscription.connectionId === connectionId),
    );
  }

  /**
   * 构造全量 snapshot 帧：fromSeq=0、toSeq=当前记账水位，payload 为当前整体配置态。
   * 不推进 sentSeq（由 reservation.commit 负责），也不清订阅缓冲。
   */
  private snapshotFrame(subscriptionId: string): WorkspaceConfigTopicFrame {
    return {
      topic: this.topic,
      subscriptionId,
      fromSeq: 0,
      toSeq: this.currentSeq,
      sentAt: this.now(),
      payload: {
        kind: "snapshot",
        snapshot: {
          protocolVersion: 1,
          workspaceId: this.workspaceId,
          logEpoch: this.logEpoch,
          config: this.state,
        },
      },
    };
  }

  /** 排出某订阅未发的增量帧；无增量返回 null。 */
  // 便捷入口：reserve 后立即 commit；生产 gateway 应持有 reservation，等物理投递成功再 commit。
  // commit 失败（订阅已被替换/删除）时返回 null，而不是抛出。
  flush(subscriptionId: string): WorkspaceConfigTopicFrame | null {
    const reservation = this.reserveFlush(subscriptionId);
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  /**
   * 为订阅预留下一帧：已有在途帧则复用；已对齐水位返回 null；
   * 否则按 deltaLog 生成 deltas 帧（断档时退化为 snapshot）。
   * 只读订阅状态，不 commit、不推进 sentSeq；无新 delta 时重复调用稳定返回同一 reservation。
   */
  reserveFlush(subscriptionId: string): TopicFrameReservation<WorkspaceConfigTopicFrame> | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;
    if (subscription.inFlight) return subscription.inFlight;
    if (subscription.sentSeq >= this.currentSeq) return null;
    return this.reserveDeltaFrame(subscription);
  }

  /**
   * 生成 (sentSeq,currentSeq] 的增量帧；重放缓冲已丢弃起点时退化为 snapshot。
   * 输出未提交 reservation，payload 固定为当时可见的 delta 列表，之后新增留给下一帧。
   * deliveryKind 标记 initial/online/recovery，供宿主决定投递优先级；本方法不改 sentSeq。
   */
  private reserveDeltaFrame(
    subscription: ConfigSubscription,
    deliveryKind: TopicFrameDeliveryKind = "online",
  ): TopicFrameReservation<WorkspaceConfigTopicFrame> {
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
   * commit：仅当订阅仍是同一对象且 inFlight 仍是本 reservation 时，把 sentSeq 推进到
   * frame.toSeq 并清空 inFlight；重复 commit 幂等返回 true；身份失配返回 false（迟到帧丢弃）。
   * 同时分配单调 logicalFrameId/Ordinal，供宿主按逻辑帧顺序投递与去重。
   */
  private reserveFrame(
    subscription: ConfigSubscription,
    frame: WorkspaceConfigTopicFrame,
    deliveryKind: TopicFrameDeliveryKind,
  ): TopicFrameReservation<WorkspaceConfigTopicFrame> {
    let committed = false;
    const reservation: TopicFrameReservation<WorkspaceConfigTopicFrame> = {
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
   * 组装订阅结果：ack、reservation、rollback，以及兼容旧调用的 frame getter。
   * frame getter 会立即 commit；生产 gateway 只应读 reservation，避免绕过物理投递确认。
   */
  private subscribeResult(
    subscriptionId: string,
    mode: "snapshot" | "resume",
    reservation: TopicFrameReservation<WorkspaceConfigTopicFrame> | null,
    rollback: () => boolean,
  ): WorkspaceConfigSubscribeResult {
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
   * 是否仍有订阅者。Resident 回收/workspace 去激活据此判断 publisher 是否可释放；
   * 只读、无副作用。
   */
  hasSubscribers(): boolean {
    return this.subscriptions.size > 0;
  }

  /**
   * 当前全部订阅 ID 快照（含在途与已对齐水位的订阅）。
   * 供 gateway dispose/清理时遍历；返回副本，调用方增删不影响内部 Map。
   */
  subscriptionIds(): string[] {
    return [...this.subscriptions.keys()];
  }

  /**
   * 反查订阅所属 connectionId；不存在返回 null。
   * 用于帧路由到具体 attachment，不校验权限（鉴权在 host/connection 层完成）。
   */
  connectionIdForSubscription(subscriptionId: string): string | null {
    return this.subscriptions.get(subscriptionId)?.connectionId ?? null;
  }
}
