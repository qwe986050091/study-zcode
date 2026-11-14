/**
 * ============================================================================
 * runtime/off-peak/lifecycle.ts —— 闲时执行的状态机与票据寿命管理
 * ============================================================================
 *
 * 【定位】一次 off-peak 执行（executionId）的生命周期：从 running_idle 开始，
 *   根据"主轮/后台/通知/输入"的工作事实在 running_idle ↔ waiting_background 间切换；
 *   票据过期进入 waiting_ticket；用户介入进入 running_user；最终 completed / cancelled。
 *
 * 【不变量】
 *   1) 只有本实例持有的当前 ticketId 能触发换票；旧 renewalId / 旧 ticketId 一律拒绝，
 *      防止延迟到达的控制消息覆盖新凭据；
 *   2) 终态（completed/cancelled）后所有方法变为幂等 no-op，等待者统一被 reject；
 *   3) 每次状态变化只发一次 state_changed（changeState 去重），完成时额外发 completed；
 *   4) 本类**不调度**模型/Bash/Agent，只决定"谁拥有执行权"和"什么时候可以停"。
 *
 * 【失败语义】不可用时抛 OffPeakLifecycleError（code 区分 cancelled/completed/user_takeover），
 *   调用方按 code 判定是否需要走接管重试。
 * ============================================================================
 */
import type { OffPeakLifecycleEvent, OffPeakLifecycleState, OffPeakOutcome } from "@zcode/shared";
export type { OffPeakLifecycleEvent, OffPeakLifecycleState, OffPeakOutcome } from "@zcode/shared";

/**
 * 闲时执行的"工作事实"快照（由 runtime 的登记表/CommandInbox/通知队列实时读取）。
 *
 * 字段口径：
 *   - mainRunning：主轮自身是否仍在校跑模型/工具（true 时不能判定为完成）；
 *   - backgroundRunning：是否还有后台任务（Bash/Agent）在跑；
 *   - pendingNotifications：是否有已生成但还没投递的后台通知（"终态→入队"的过渡态）；
 *   - pendingInputs：是否有排队中的引导/输入（未消费的输入也算未完成工作）。
 * 四个都为 false 且无待续票据、无在途模型轮次时，状态机才可进入 completed。
 */
/** 工作事实由 Runtime 登记表、CommandInbox 与通知队列提供；此处不再维护副本。 */
export interface OffPeakWorkSnapshot {
  mainRunning: boolean;
  backgroundRunning: boolean;
  pendingNotifications: boolean;
  pendingInputs: boolean;
}

/**
 * 去掉身份字段后的事件载荷：emit 时再统一补上 executionId/offPeakTaskId。
 *
 * 好处是状态机内部只关心语义（state/ticket/outcome），身份拼接只有 emit 一处，
 * 不会出现某个事件漏带 identity 的情况。
 */
type WithoutIdentity<T> = T extends unknown ? Omit<T, "executionId" | "offPeakTaskId"> : never;
type LifecycleEffect = WithoutIdentity<OffPeakLifecycleEvent>;

/**
 * 状态机不可用时的内部错误。
 *
 * code 三值语义：
 *   - off_peak_user_takeover：用户已接管，原执行方应放弃继续（不是失败，是让位）；
 *   - off_peak_cancelled：执行被取消；
 *   - off_peak_completed：执行已完成，再取票/等票没有意义。
 * 故意用 code 而非 message 做判定，避免文案变化影响控制流。
 */
class OffPeakLifecycleError extends Error {
  constructor(
    readonly code: "off_peak_user_takeover" | "off_peak_cancelled" | "off_peak_completed",
  ) {
    super(code);
    this.name = "OffPeakLifecycleError";
  }
}

/**
 * 等待新票据的挂起者。
 *
 * resolve 在换票成功时拿到新 ticketId；reject 在取消/接管/完成或 abort 时收到错误。
 * 由 waitForTicket 负责在两种结局下都从 waiters 集合移除，避免泄漏。
 */
interface TicketWaiter {
  resolve(ticketId: string): void;
  reject(error: unknown): void;
}

/** 仅管理闲时归属和票据寿命，不调度模型、Bash 或 Agent。 */
/**
 * 闲时执行生命周期状态机。
 *
 * 只管"归属 + 票据寿命"，是 off-peak 的闸门：runtime 在每次请求前向它 waitForTicket，
 *   拿到票才能继续用闲时模型；票据被宿主判过期时它发出 ticket_needed，等 Host 下发新票。
 * 状态转移由 workChanged 统一推导；所有公开变更方法在终态/用户接管下均退化为 no-op。
 *
 * 字段口径：
 *   - phase：当前状态（初值 running_idle）；
 *   - userOwned：用户是否已接管（true 期间不再发放闲时票，除已有在途模型轮次）；
 *   - ticketId：当前有效票据；undefined 表示无票（完成/接管/未持有）；
 *   - ticketAvailable：当前票是否可用；换票流程中被置 false 防止旧票继续发放；
 *   - renewalSequence / pendingRenewal：换票序号生成器与"正在等 Host 回执"的那次序号；
 *   - appliedRenewal：最近一次成功安装的 (renewalId, ticketId)，用于回执丢失时幂等确认；
 *   - idleModelRounds：仍在跑的模型轮次数，>0 时即使接管/终态也不释放票据（在途请求需收尾）；
 *   - outcome：主轮结束时的结果（succeeded/failed/stopped），完成事件里上报；
 *   - waiters / releasedTickets：等待换票的挂起者集合，以及已发出释放事件的票据集合（去重）。
 */
export class OffPeakLifecycle {
  private phase: OffPeakLifecycleState = "running_idle";
  private userOwned = false;
  private ticketId: string | undefined;
  private ticketAvailable = true;
  private renewalSequence = 0;
  private pendingRenewal: number | undefined;
  private appliedRenewal: { renewalId: number; ticketId: string } | undefined;
  private idleModelRounds = 0;
  private outcome: OffPeakOutcome = "succeeded";
  private readonly waiters = new Set<TicketWaiter>();
  private readonly releasedTickets = new Set<string>();

/**
 * 创建状态机。
 *
 * 输入：executionId / offPeakTaskId（身份，emit 时补进事件）、初始 ticketId、
 *   readWork（每次推导状态的唯一事实来源）、emit（事件出口，由 runtime 负责转发/落库）。
 * 副作用：持有初始票（但尚未发放给调用方）；不主动 emit 初始 state_changed。
 */
  constructor(
    private readonly deps: {
      executionId: string;
      offPeakTaskId: string;
      ticketId: string;
      readWork(): OffPeakWorkSnapshot;
      emit(event: OffPeakLifecycleEvent): void;
    },
  ) {
    this.ticketId = deps.ticketId;
  }

  /** 当前状态（只读）；外部据此做 UI 展示与调试判定，不可直接改写。 */
  get state(): OffPeakLifecycleState {
    return this.phase;
  }
  /** 用户是否已接管：true 表示闲时执行将执行权让给用户轮，不再发放新票。 */
  get ownedByUser(): boolean {
    return this.userOwned;
  }
  /** 是否已进入终态（completed 或 cancelled）；终态后所有变更方法都是 no-op。 */
  get terminal(): boolean {
    return this.phase === "completed" || this.phase === "cancelled";
  }

/**
 * 登记一次"正在使用闲时模型"的轮次，返回释放句柄。
 *
 * 用途：模型请求在途期间必须占住票据，否则宿主可能在请求未结束时回收/换票。
 * 输入：无。输出：{ release } —— 幂等，可安全重复调用。
 * 失败：已终态或已被用户接管时抛 OffPeakLifecycleError（不能让闲时执行继续抢票）。
 * 副作用：idleModelRounds++；release 时 --、尝试释放未用票据并重算状态。
 * 不变量：release 后即使被多次调用也只减一次（released 标记）。
 */
  retainIdleModelRound(): { release(): void } {
    if (this.terminal || this.userOwned) throw this.unavailableError();
    this.idleModelRounds++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.idleModelRounds--;
        this.releaseUnusedTicket();
        this.workChanged();
      },
    };
  }

/**
 * 上报主轮结束及其结果，并触发一次状态重算。
 *
 * 输入：outcome（succeeded/failed/stopped），会保存到 this.outcome，供最终 completed 事件使用。
 * 输出：无。终态后直接返回（不再改写结果，保证第一次终态结论不被覆盖）。
 * 副作用：可能因工作事实已清空而立即进入 completed 并发出 completed 事件。
 */
  mainEnded(outcome: OffPeakOutcome): void {
    if (this.terminal) return;
    this.outcome = outcome;
    this.workChanged();
  }

/**
 * 重新读取工作事实并推导下一个状态（状态机的唯一转移入口）。
 *
 * 输入：无（调 deps.readWork()）。输出：无。
 * 完成条件：主轮/后台/通知/待处理输入全部为空，且没有待续票据、没有在途模型轮次
 *   → 进入 completed，reject 所有等待者，释放未用票据，发 completed(outcome)。
 * 否则按优先级推导：userOwned → running_user；有待续票据 → waiting_ticket；
 *   主轮仍在跑 → running_idle；其余 → waiting_background。
 * 副作用：可能发 state_changed / completed 事件；终态后不再执行任何转移。
 */
  workChanged(): void {
    if (this.terminal) return;
    const work = this.deps.readWork();
    // 票据等待也是未完成工作；后台终态到通知入队的过渡由 readWork 的通知事实覆盖。
    if (
      !work.mainRunning &&
      !work.backgroundRunning &&
      !work.pendingNotifications &&
      !work.pendingInputs &&
      this.pendingRenewal === undefined &&
      this.idleModelRounds === 0
    ) {
      this.changeState("completed");
      this.rejectWaiters(this.unavailableError());
      this.releaseUnusedTicket();
      this.emit({ type: "completed", outcome: this.outcome });
      return;
    }
    this.changeState(
      this.userOwned
        ? "running_user"
        : this.pendingRenewal !== undefined
          ? "waiting_ticket"
          : work.mainRunning
            ? "running_idle"
            : "waiting_background",
    );
  }

/**
 * 宿主判定票据过期时调用：申请一次换票。
 *
 * 输入：被判定过期的 ticketId。输出：本次 renewalId；不处理则 undefined。
 * 拒绝条件：已终态、用户已接管、或传入的票不是当前持有票（旧票的过期通知不能影响新票）。
 * 幂等：若已有 pendingRenewal，直接返回同一个 renewalId，不重复发 ticket_needed
 *   —— 宿主可能对同一张票重复报过期。
 * 副作用：ticketAvailable=false（暂停发票）、状态转 waiting_ticket、emit ticket_needed。
 */
  ticketExpired(ticketId: string): number | undefined {
    if (this.terminal || this.userOwned || this.ticketId !== ticketId) return undefined;
    if (this.pendingRenewal !== undefined) return this.pendingRenewal;
    this.pendingRenewal = ++this.renewalSequence;
    this.ticketAvailable = false;
    this.changeState("waiting_ticket");
    this.emit({ type: "ticket_needed", renewalId: this.pendingRenewal, expiredTicketId: ticketId });
    return this.pendingRenewal;
  }

/**
 * 安装 Host 下发的新票据（对换票请求的回执）。
 *
 * 输入：renewalId（对应 ticketExpired 返回的序号）+ 新 ticketId。
 * 输出：true = 已安装或此前已安装同一对（幂等成功）；false = 拒绝。
 * 拒绝条件：已终态/用户接管、renewalId 不是当前待处理序号、新票与旧票相同。
 * 幂等：控制回执可能丢失后重试，若 appliedRenewal 已是同一对 (renewalId, ticketId) 直接 true，
 *   避免重复发 ticket_released。
 * 副作用：替换 ticketId、清 pendingRenewal、ticketAvailable=true、释放旧票事件、
 *   resolve 所有等待者（它们继续消费原结果，不会重建工作或重跑 Bash）、重算状态。
 */
  replaceTicket(renewalId: number, ticketId: string): boolean {
    // 控制回执可能丢失；只确认最近一次已经安装的票，不能让旧重试覆盖更新的凭据。
    if (this.appliedRenewal?.renewalId === renewalId && this.appliedRenewal.ticketId === ticketId)
      return true;
    if (
      this.terminal ||
      this.userOwned ||
      this.pendingRenewal !== renewalId ||
      ticketId === this.ticketId
    )
      return false;
    const previousTicket = this.ticketId;
    this.appliedRenewal = { renewalId, ticketId };
    this.ticketId = ticketId;
    this.ticketAvailable = true;
    this.pendingRenewal = undefined;
    // 旧票已过期。换票不会重建工作，也不会重复执行 Bash；等待方继续消费原来的结果。
    if (previousTicket) this.releaseTicket(previousTicket);
    for (const waiter of this.waiters) waiter.resolve(ticketId);
    this.waiters.clear();
    this.workChanged();
    return true;
  }

/**
 * 等待一张可用的闲时票（模型请求前的闸门）。
 *
 * 输入：可选 AbortSignal（停止等待）。输出：Promise<ticketId>。
 * 立即 resolve 的条件：票可用、无待续换票、有 ticketId，且（未接管或有在途模型轮次）。
 * 立即 reject 的条件：signal 已 abort、已终态、已被接管且无在途轮次。
 * 否则挂起：把 waiter 加入集合，abort 时 reject；resolve/reject 都会清理监听与集合条目。
 * 副作用：仅注册/清理等待者，不发事件。
 */
  waitForTicket(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.terminal) return Promise.reject(this.unavailableError());
    if (
      this.ticketAvailable &&
      this.pendingRenewal === undefined &&
      this.ticketId &&
      (!this.userOwned || this.idleModelRounds > 0)
    ) {
      return Promise.resolve(this.ticketId);
    }
    if (this.userOwned) return Promise.reject(this.unavailableError());
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(waiter);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: TicketWaiter = {
        resolve: (ticketId) => {
          cleanup();
          resolve(ticketId);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const onAbort = () => waiter.reject(signal?.reason);
      this.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

/**
 * 标记用户已接管：闲时执行让位，不再发放票据。
 *
 * 输出：无。终态或已接管时 no-op（幂等）。
 * 副作用：userOwned=true、清 pendingRenewal、reject 所有等票者、emit user_takeover、
 *   释放未用票据（若无在途模型轮次）、重算状态（通常转 running_user）。
 * 注意：在途模型轮次不会被强制中断，它们完成后再释放票据。
 */
  takeOver(): void {
    if (this.terminal || this.userOwned) return;
    this.userOwned = true;
    this.pendingRenewal = undefined;
    this.rejectWaiters(this.unavailableError());
    this.emit({ type: "user_takeover" });
    this.releaseUnusedTicket();
    this.workChanged();
  }

/**
 * 取消执行并进入终态。
 *
 * 输出：无。已终态时 no-op。
 * 副作用：清 pendingRenewal、状态转 cancelled、reject 等票者、释放未用票据、
 *   发 completed(outcome="stopped") —— 取消对外表现为"以 stopped 结束"，而不是单独一种终态事件。
 */
  cancel(): void {
    if (this.terminal) return;
    this.pendingRenewal = undefined;
    this.changeState("cancelled");
    this.rejectWaiters(this.unavailableError());
    this.releaseUnusedTicket();
    this.emit({ type: "completed", outcome: "stopped" });
  }

/**
 * 构造"当前不可用"的错误（私有）。
 *
 * code 按当前 phase 推导：cancelled → off_peak_cancelled；completed → off_peak_completed；
 *   其余（含 running_user / waiting_ticket 等）→ off_peak_user_takeover。
 * 因为除两个终态外，唯一拒绝原因就是用户接管。
 */
  private unavailableError(): OffPeakLifecycleError {
    return new OffPeakLifecycleError(
      this.phase === "cancelled"
        ? "off_peak_cancelled"
        : this.phase === "completed"
          ? "off_peak_completed"
          : "off_peak_user_takeover",
    );
  }

/**
 * 拒绝并清空所有等待者（私有）。
 *
 * 同一个 error 实例分发给所有 waiter：调用方只需按 code 判定，不需要区分个体。
 * 副作用：清空 waiters 集合，避免后续 resolve 到已失效的 Promise。
 */
  private rejectWaiters(error: unknown): void {
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }

/**
 * 在"没有在途模型轮次且不再需要票"时释放当前票（私有）。
 *
 * 释放条件：已接管或已终态，且 idleModelRounds === 0（在途请求仍需票收尾），且有 ticketId。
 * 输出：无。副作用：清空 ticketId 并发 ticket_released 事件（由 releaseTicket 去重）。
 */
  private releaseUnusedTicket(): void {
    if ((!this.userOwned && !this.terminal) || this.idleModelRounds > 0 || !this.ticketId) return;
    const ticketId = this.ticketId;
    this.ticketId = undefined;
    this.releaseTicket(ticketId);
  }

/**
 * 发送"票据已释放"事件（私有），按 ticketId 去重。
 *
 * 去重意义：换票（旧票释放）与终态释放可能针对同一张票，下游不应重复见到释放事件。
 * 副作用：加入 releasedTickets 集合并 emit；集合只增不减（票据 id 不复用）。
 */
  private releaseTicket(ticketId: string): void {
    if (this.releasedTickets.has(ticketId)) return;
    this.releasedTickets.add(ticketId);
    this.emit({ type: "ticket_released", ticketId });
  }

/**
 * 状态迁移 + 去重发事件（私有）。
 *
 * 相同状态不发事件，保证下游看到的是"变化"而非"重算"；真实变化则 emit state_changed。
 * 副作用：写 this.phase 并 emit。
 */
  private changeState(state: OffPeakLifecycleState): void {
    if (state === this.phase) return;
    this.phase = state;
    this.emit({ type: "state_changed", state });
  }

/**
 * 统一事件出口（私有）：把语义载荷补上 identity 后交给 deps.emit。
 *
 * 副作用：调用外部 emit（可能是异步落库/转发）；本函数不处理 emit 抛错，由上层保证。
 */
  private emit(effect: LifecycleEffect): void {
    this.deps.emit({
      ...effect,
      executionId: this.deps.executionId,
      offPeakTaskId: this.deps.offPeakTaskId,
    });
  }
}
