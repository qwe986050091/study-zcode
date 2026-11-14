// CLI session 常驻池。
//
// 这是容量与生命周期控制器，不拥有 session 内容。宿主提供当前 resident registry、同步
// 安全事实和去激活执行面；pool 只维护 idle TTL、LRU touch、operation lease 与
// deactivation gate。
//
// 关键不变量（顺序敏感）：
// 1. 只要还有任意 operation lease（全进程 activeOperationCount > 0），rebalance 不启动；
// 2. 去激活候选必须同时满足 persisted + 无阻塞工作/交互/排队命令/订阅 + 本 session lease 为 0；
// 3. 候选快照与执行之间必须重读 fresh facts，避免用过期 LRU 关掉刚开始运行/刚订阅的 session；
// 4. deactivate 的首个同步片段先把 session 从 resident registry 摘除，异步收尾期间
//    inFlightDeactivations 会阻止同 session 的 acquireOperation 抢跑。

export const DEFAULT_SESSION_RESIDENT_TARGET_COUNT = 8;
export const DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT = 16;
export const DEFAULT_SESSION_RESIDENT_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

export type SessionDeactivationReason = "high_water_lru" | "idle_timeout";

export interface SessionDeactivationDecision {
  highWaterCount: number;
  idleMs: number;
  idleTimeoutMs: number;
  reason: SessionDeactivationReason;
  residentCountBefore: number;
  targetCount: number;
}

export interface SessionResidencyFacts {
  persisted: boolean;
  hasResidencyBlockingWork: boolean;
  hasPendingInteractions: boolean;
  hasQueuedCommands: boolean;
  hasSubscribers: boolean;
  hasLegacySubscriber: boolean;
  lastActivityAt: number;
}

export interface SessionResidentPoolHost {
  listSessionIds(): string[];
  readResidencyFacts(sessionId: string): SessionResidencyFacts | null;
  /**
   * 首个同步执行片必须把 session 从 resident registry 摘除；返回 Promise 只等待
   * app.close 等异步收尾。
   */
  deactivate(sessionId: string): Promise<void>;
  onDeactivated?(sessionId: string, decision: SessionDeactivationDecision): void;
  onError?(sessionId: string, error: unknown, decision: SessionDeactivationDecision): void;
}

export interface SessionResidentPoolOptions {
  highWaterCount?: number;
  idleTimeoutMs?: number;
  now?: () => number;
  targetCount?: number;
}

interface ResidencyCandidate {
  eligibleSinceAt: number;
  lastUsedAt: number;
  sessionId: string;
}

/**
 * 常驻 session 池：按 target/highWater 两级水位与 idle TTL 回收内存中的 runtime。
 *
 * 输入：host 提供的 resident 列表、residency facts、deactivate 执行面；options 只影响
 * 阈值与时钟。输出：无查询 API，效果通过 `acquireOperation` 的 lease 与 host 回调体现。
 * 副作用：调用 host.deactivate（异步），并分别回调 onDeactivated/onError。
 * 失败语义：构造时非法阈值立即 RangeError；deactivate 同步抛错只记 onError 且保留 resident；
 * lease 等待失败会释放已占计数后原样抛错。构造参数校验先于任何状态初始化。
 */
export class SessionResidentPool {
  private readonly highWaterCount: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly targetCount: number;
  private readonly eligibleSinceAt = new Map<string, number>();
  private readonly lastTouchedAt = new Map<string, number>();
  private readonly operationLeaseCounts = new Map<string, number>();
  private readonly inFlightDeactivations = new Map<string, Promise<void>>();
  private activeOperationCount = 0;
  private rebalancing = false;

  constructor(
    private readonly host: SessionResidentPoolHost,
    options: SessionResidentPoolOptions = {},
  ) {
    const targetCount = options.targetCount ?? DEFAULT_SESSION_RESIDENT_TARGET_COUNT;
    const highWaterCount = options.highWaterCount ?? DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SESSION_RESIDENT_IDLE_TIMEOUT_MS;
    if (!Number.isInteger(targetCount) || targetCount < 0) {
      throw new RangeError("session resident targetCount must be a non-negative integer");
    }
    if (!Number.isInteger(highWaterCount) || highWaterCount < targetCount) {
      throw new RangeError(
        "session resident highWaterCount must be an integer greater than or equal to targetCount",
      );
    }
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) {
      throw new RangeError("session resident idleTimeoutMs must be a non-negative number");
    }
    this.targetCount = targetCount;
    this.highWaterCount = highWaterCount;
    this.idleTimeoutMs = idleTimeoutMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * 获取协议请求租约。全进程计数防跨 session 的 async workspace 操作与 sampler
   * 回收并发；按 session 计数表达精确所有权并参与该 session 的 eligibility。
   *
   * 输入：单个 sessionId、数组或空（仅全局计数）。返回幂等的 release 闭包：
   * 重复调用只生效一次，最后一次释放会触发 rebalance。副作用：先占计数再等待
   * 该 session 的 in-flight 去激活；等待失败时回滚全部计数并抛错，不留半占状态。
   * 调用方必须在整段异步操作期间持有 lease，否则 sampler 可能在操作中回收 runtime。
   */
  async acquireOperation(
    sessionIdsInput?: string | readonly string[],
  ): Promise<() => void> {
    const sessionIds = [
      ...new Set(
        (typeof sessionIdsInput === "string" ? [sessionIdsInput] : sessionIdsInput ?? []).filter(
          (sessionId) => sessionId.length > 0,
        ),
      ),
    ];
    this.activeOperationCount += 1;
    for (const sessionId of sessionIds) {
      this.operationLeaseCounts.set(
        sessionId,
        (this.operationLeaseCounts.get(sessionId) ?? 0) + 1,
      );
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const sessionId of sessionIds) {
        this.touch(sessionId);
        const next = (this.operationLeaseCounts.get(sessionId) ?? 1) - 1;
        if (next <= 0) this.operationLeaseCounts.delete(sessionId);
        else this.operationLeaseCounts.set(sessionId, next);
      }
      this.activeOperationCount = Math.max(0, this.activeOperationCount - 1);
      this.rebalance();
    };

    try {
      for (const sessionId of sessionIds) {
        await this.waitForDeactivation(sessionId);
        this.touch(sessionId);
      }
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * 记录一次「使用」：lastTouchedAt 只增不减（乱序时间戳不会回退水位），
   * 并清掉 eligibleSinceAt 让 idle TTL 从本次使用重新计时。
   * 非有限时间戳直接忽略，避免 NaN 污染 LRU 排序。
   */
  touch(sessionId: string, usedAt = this.now()): void {
    if (!Number.isFinite(usedAt)) return;
    const previous = this.lastTouchedAt.get(sessionId);
    if (previous === undefined || usedAt > previous) {
      this.lastTouchedAt.set(sessionId, usedAt);
    }
    // idle TTL 表达“最后一次使用后的连续空闲”，协议请求重新使用 session
    // 后必须重新计时，不能沿用 touch 前已经接近到期的 eligible 窗口。
    this.eligibleSinceAt.delete(sessionId);
  }

  /** sampler 与 request-release 共用的 TTL / 高低水位收敛入口。 */
  // 两阶段顺序固定：先按 eligibleSince 升序回收 idle 超时，再重读 resident 数量；
  // 只有仍超过 highWater 时才按 lastUsed 升序（LRU）回收到 target。每个候选执行前
  // 重读 fresh facts 并二次确认 eligibleSince 已满 TTL。`rebalancing` 防重入，
  // `activeOperationCount > 0` 期间全程不启动。
  rebalance(): void {
    if (this.activeOperationCount > 0 || this.rebalancing) return;
    this.rebalancing = true;
    try {
      const observedAt = this.now();
      const initialResidentIds = this.host.listSessionIds();
      this.pruneMetadata(new Set(initialResidentIds));
      const initialCandidates = this.readCandidates(initialResidentIds, observedAt);
      const expiredCandidates = initialCandidates
        .filter((candidate) => observedAt - candidate.eligibleSinceAt >= this.idleTimeoutMs)
        .sort(
          (left, right) =>
            left.eligibleSinceAt - right.eligibleSinceAt ||
            left.lastUsedAt - right.lastUsedAt ||
            left.sessionId.localeCompare(right.sessionId),
        );

      let residentCount = initialResidentIds.length;
      for (const candidate of expiredCandidates) {
        if (this.activeOperationCount > 0) break;
        // 候选收集后可能重新订阅或启动后台任务，TTL 到期也不能绕过
        // fresh facts 与 eligibleSince 二次校验。
        const freshFacts = this.host.readResidencyFacts(candidate.sessionId);
        if (!freshFacts || !this.isEligible(candidate.sessionId, freshFacts)) {
          this.eligibleSinceAt.delete(candidate.sessionId);
          continue;
        }
        const eligibleSinceAt = this.eligibleSinceAt.get(candidate.sessionId);
        if (eligibleSinceAt === undefined || observedAt - eligibleSinceAt < this.idleTimeoutMs) {
          continue;
        }
        const decision = this.createDecision(
          "idle_timeout",
          residentCount,
          observedAt - eligibleSinceAt,
        );
        if (this.executeDeactivation(candidate.sessionId, decision)) {
          residentCount -= 1;
        }
      }

      const remainingResidentIds = this.host.listSessionIds();
      residentCount = remainingResidentIds.length;
      if (residentCount <= this.highWaterCount) return;

      const highWaterCandidates = this.readCandidates(remainingResidentIds, observedAt).sort(
        (left, right) =>
          left.lastUsedAt - right.lastUsedAt || left.sessionId.localeCompare(right.sessionId),
      );

      for (const candidate of highWaterCandidates) {
        if (residentCount <= this.targetCount || this.activeOperationCount > 0) break;
        // 候选收集与执行之间可能有订阅/后台任务等新事实。执行前必须重读，
        // 不能让过期 LRU 快照取消仍在运行的 session。
        const freshFacts = this.host.readResidencyFacts(candidate.sessionId);
        if (!freshFacts || !this.isEligible(candidate.sessionId, freshFacts)) {
          this.eligibleSinceAt.delete(candidate.sessionId);
          continue;
        }
        const eligibleSinceAt = this.eligibleSinceAt.get(candidate.sessionId) ?? observedAt;
        const decision = this.createDecision(
          "high_water_lru",
          residentCount,
          observedAt - eligibleSinceAt,
        );
        if (this.executeDeactivation(candidate.sessionId, decision)) {
          residentCount -= 1;
        }
      }
    } finally {
      this.rebalancing = false;
    }
  }

  // 冷恢复入口用它等待旧 app.close 收尾；没有在途去激活时立即 resolve。
  waitForDeactivation(sessionId: string): Promise<void> {
    return this.inFlightDeactivations.get(sessionId) ?? Promise.resolve();
  }

  // 回收资格的唯一判定：持久化完成、没有阻塞工作/待交互/排队命令/订阅者、
  // 本 session 无 lease、且没有在途去激活。任一不满足即视为不可回收（fail-safe）。
  private isEligible(sessionId: string, facts: SessionResidencyFacts): boolean {
    return (
      facts.persisted &&
      !facts.hasResidencyBlockingWork &&
      !facts.hasPendingInteractions &&
      !facts.hasQueuedCommands &&
      !facts.hasSubscribers &&
      !facts.hasLegacySubscriber &&
      (this.operationLeaseCounts.get(sessionId) ?? 0) === 0 &&
      !this.inFlightDeactivations.has(sessionId)
    );
  }

  // 生成候选快照：不合格者立即清掉 eligibleSince（下次重新计时），
  // 首次合格者以本次 observedAt 为起点；lastUsedAt 取宿主活动时间与本地 touch 的较大值。
  private readCandidates(sessionIds: readonly string[], observedAt: number): ResidencyCandidate[] {
    const candidates: ResidencyCandidate[] = [];
    for (const sessionId of sessionIds) {
      const facts = this.host.readResidencyFacts(sessionId);
      if (!facts || !this.isEligible(sessionId, facts)) {
        this.eligibleSinceAt.delete(sessionId);
        continue;
      }
      let eligibleSinceAt = this.eligibleSinceAt.get(sessionId);
      if (eligibleSinceAt === undefined) {
        eligibleSinceAt = observedAt;
        this.eligibleSinceAt.set(sessionId, eligibleSinceAt);
      }
      candidates.push({
        eligibleSinceAt,
        lastUsedAt: Math.max(
          facts.lastActivityAt,
          this.lastTouchedAt.get(sessionId) ?? Number.NEGATIVE_INFINITY,
        ),
        sessionId,
      });
    }
    return candidates;
  }

  // 决策快照只用于回调/日志；idleMs 夹到非负，避免时钟回拨产生负数。
  private createDecision(
    reason: SessionDeactivationReason,
    residentCountBefore: number,
    idleMs: number,
  ): SessionDeactivationDecision {
    return {
      highWaterCount: this.highWaterCount,
      idleMs: Math.max(0, idleMs),
      idleTimeoutMs: this.idleTimeoutMs,
      reason,
      residentCountBefore,
      targetCount: this.targetCount,
    };
  }

  // 启动去激活并登记在途 Promise；同步抛错（尚未真正开始关闭）视为未回收，返回 false。
  // 登记成功即清掉 touch/eligible 元数据：该 session 已不再属于可回收候选集。
  private executeDeactivation(sessionId: string, decision: SessionDeactivationDecision): boolean {
    let pending: Promise<void>;
    try {
      pending = this.host.deactivate(sessionId);
    } catch (error) {
      this.host.onError?.(sessionId, error, decision);
      return false;
    }

    const tracked = pending
      .then(() => this.host.onDeactivated?.(sessionId, decision))
      .catch((error: unknown) => this.host.onError?.(sessionId, error, decision))
      .finally(() => {
        if (this.inFlightDeactivations.get(sessionId) === tracked) {
          this.inFlightDeactivations.delete(sessionId);
        }
      });
    this.inFlightDeactivations.set(sessionId, tracked);
    this.eligibleSinceAt.delete(sessionId);
    this.lastTouchedAt.delete(sessionId);
    return true;
  }

  // 清理已离开 registry 的元数据；在途去激活与仍持 lease 的 session 保留记录，
  // 因为后续 release/then 仍要读写它们。
  private pruneMetadata(residentIds: ReadonlySet<string>): void {
    for (const sessionId of this.lastTouchedAt.keys()) {
      if (
        !residentIds.has(sessionId) &&
        !this.inFlightDeactivations.has(sessionId) &&
        !this.operationLeaseCounts.has(sessionId)
      ) {
        this.lastTouchedAt.delete(sessionId);
      }
    }
    for (const sessionId of this.eligibleSinceAt.keys()) {
      if (!residentIds.has(sessionId) && !this.inFlightDeactivations.has(sessionId)) {
        this.eligibleSinceAt.delete(sessionId);
      }
    }
  }
}
