import type {
  OffPeakControlParams,
  OffPeakControlResult,
  OffPeakLifecycleNotification,
  OffPeakOutcome,
} from "@zcode/shared";

// 换票控制需要完整请求鉴权，类型直接从协议参数中取，避免重复定义。
type RequestAuth = Extract<OffPeakControlParams, { action: "replace_ticket" }>["requestAuth"];
// 一次换票交接的完整状态：控制命令、旧票与在途 Promise。
interface TicketDelivery {
  control: Extract<OffPeakControlParams, { action: "replace_ticket" }>;
  previousTicketId: string;
  inFlight?: Promise<void>;
}
// 注册信息由 CLI 侧提供；Host 只持有回调，不复制业务状态。
interface Registration {
  offPeakTaskId: string;
  executionId: string;
  sessionId: string;
  ticketId: string;
  control(input: OffPeakControlParams): Promise<OffPeakControlResult>;
  complete(outcome: OffPeakOutcome): Promise<void>;
  disposed?(): void;
}
// 驻留执行在注册信息之上叠加 Host 侧生命周期标记。
interface ResidentExecution extends Registration {
// ready 在首轮 admission 后 resolve，之前收到的事件先挂起。
  ready: Promise<void>;
  admit(): void;
// discarded 表示该执行已被替换或销毁，后续事件全部忽略。
  discarded: boolean;
// userOwned 表示用户接管或取消，Host 不得再自动续票。
  userOwned: boolean;
// terminal 一旦置位就不再接受新的续票请求。
  terminal: boolean;
// renewalId 标识续票代次，旧代次的迟到回执不得覆盖新状态。
  renewalId?: number;
  ticketDelivery?: TicketDelivery;
// completedWritten 记录完成结果是否已写回 CLI。
  completedWritten: boolean;
// releasedTickets 防止同一票据被重复释放。
  releasedTickets: Set<string>;
}

/** Host 只关联驻留执行和票据请求；后台工作清单与完成判断仍由 CLI 唯一维护。 */
// 本类只做关联与路由，工作清单与完成判定仍由 CLI 唯一维护。
export class OffPeakResidentExecutions {
// 以 offPeakTaskId 为键，一个任务同一时刻最多一个驻留执行。
  private readonly runs = new Map<string, ResidentExecution>();

  constructor(
// 续票、接管与释放都由外部注入，便于替换 CLI 适配层。
    private readonly deps: {
      renew(taskId: string, current: () => boolean): Promise<void>;
      takeover(taskId: string): Promise<void>;
      release(ticketId: string): Promise<void>;
    },
  ) {}

// 注册返回两个控制句柄：admission 通知与销毁。
  register(input: Registration): { admitted(): void; dispose(): void } {
// 同任务已有未收口执行时拒绝重复注册。
    const previous = this.runs.get(input.offPeakTaskId);
// 只有已终态或已丢弃的执行允许被新执行替换。
    if (previous && !previous.terminal && !previous.discarded)
      throw new Error("off_peak_execution_already_registered");
// admit 在 Promise 构造器内赋值，注册方稍后调用。
    let admit!: () => void;
    const ready = new Promise<void>((resolve) => {
      admit = resolve;
    });
// 新注册的 userOwned 与 terminal 一律从 false 开始。
    const run: ResidentExecution = {
      ...input,
      ready,
      admit,
      discarded: false,
      userOwned: false,
      terminal: false,
      completedWritten: false,
      releasedTickets: new Set(),
    };
// runs.set 覆盖旧条目是安全的，旧条目只可能已 terminal 或 discarded。
    this.runs.set(input.offPeakTaskId, run);
    return {
// admitted 与内部 admit 同一函数，便于 CLI 直接调用。
      admitted: admit,
// dispose 幂等：重复调用只重复置位与 resolve。
      dispose: () => {
        run.discarded = true;
        admit();
// 只删除仍指向本执行的条目，避免误删新注册。
        if (this.runs.get(input.offPeakTaskId) === run) this.runs.delete(input.offPeakTaskId);
      },
    };
  }

// 守卫在续票前后各调用一次，用代次与状态双重校验。
  retakeGuard(taskId: string): () => boolean {
    const run = this.runs.get(taskId);
// 捕获当下代次，用于检测续票期间是否发生变化。
    const renewalId = run?.renewalId;
// 无执行时允许续票：任务可能尚未注册到 Host。
    return () =>
      run
        ? this.runs.get(taskId) === run &&
          !run.discarded &&
          !run.userOwned &&
          !run.terminal &&
          !run.ticketDelivery &&
          renewalId !== undefined &&
          run.renewalId === renewalId
        : !this.runs.has(taskId);
  }

// 供派发层判断是否还要自动续票。
  isUserOwned(taskId: string): boolean {
    return this.runs.get(taskId)?.userOwned === true;
  }
// 只关心是否注册，不暴露内部执行对象。
  has(taskId: string): boolean {
    return this.runs.has(taskId);
  }
// 释放票据走 deps，保证与正常释放同一条路径。
  discardTicket(ticketId: string): Promise<void> {
    return this.deps.release(ticketId);
  }

// 生命周期事件入口：先同步更新状态，再按类型分派。
  async handle(event: OffPeakLifecycleNotification): Promise<void> {
// 找不到执行说明事件属于已卸载任务，直接丢弃。
    const run = this.runs.get(event.offPeakTaskId);
    if (
      !run ||
      run.discarded ||
// executionId 与 sessionId 必须同时匹配，防止旧事件串到新执行。
      run.executionId !== event.executionId ||
      run.sessionId !== event.sessionId
    )
      return;
// 续票事件只接受严格递增的代次。
    if (event.type === "ticket_needed") {
// userOwned 或 terminal 为真时忽略续票，renewalId 不前进也忽略。
      if (run.userOwned || run.terminal || event.renewalId <= (run.renewalId ?? 0)) return;
      // CLI 已开始下一次续票，旧交接已被其消费；迟到 ACK 不得倒写新的票据归属。
      run.ticketDelivery = undefined;
// 新代次开始即作废旧交接，迟到的 ACK 不再回写。
      run.renewalId = event.renewalId;
    }
// 接管后清空代次，Host 不再参与续票。
    if (event.type === "user_takeover") {
      run.userOwned = true;
      run.renewalId = undefined;
    }
// 完成是终态事件，重复到达只处理一次。
    if (event.type === "completed") {
      if (run.terminal) return;
      run.terminal = true;
      run.renewalId = undefined;
    }
    await run.ready;
    if (run.discarded) return;
// 首轮 admission 之前收到的事件在此等待，醒后必须复核销毁状态。
    switch (event.type) {
// 续票委托给 deps，守卫函数保证执行时仍然合法。
      case "ticket_needed": {
        const current = this.retakeGuard(event.offPeakTaskId);
// 守卫不通过则不续票，交由 CLI 侧重试或收口。
        if (current()) await this.deps.renew(event.offPeakTaskId, current);
        return;
      }
      case "user_takeover":
        await this.deps.takeover(event.offPeakTaskId);
        return;
// 票据释放直接调用 deps，并登记已释放集合。
      case "ticket_released":
        await this.deps.release(event.ticketId);
// 登记后 finish 才能判定该执行是否可回收。
        run.releasedTickets.add(event.ticketId);
        this.finish(run);
        return;
// 完成回调写回结果，标记已写后尝试收口。
      case "completed":
        await run.complete(event.outcome);
        run.completedWritten = true;
        this.finish(run);
        return;
// 状态变更不涉及票据与终端，Host 不做处理。
      case "state_changed":
        return;
    }
  }

// 把新票据交给 CLI；返回 sessionId 供调用方关联。
  async deliverTicket(
    taskId: string,
    ticketId: string,
    requestAuth: RequestAuth,
  ): Promise<{ sessionId: string } | undefined> {
    const run = this.runs.get(taskId);
// 未注册或已销毁时返回 undefined，由调用方自行释放票据。
    if (!run || run.discarded) return undefined;
    await run.ready;
    if (run.discarded) return undefined;
    const pendingDelivery = run.ticketDelivery;
    if (pendingDelivery) {
      if (pendingDelivery.control.ticketId !== ticketId) await this.deps.release(ticketId);
      if (run.ticketDelivery === pendingDelivery) await this.sendTicket(run, pendingDelivery);
      return { sessionId: run.sessionId };
    }
// renewalId 为 undefined 或 userOwned 时不再安装新票。
    const renewalId = run.renewalId;
    if (renewalId === undefined || run.userOwned || run.terminal) {
      if (ticketId !== run.ticketId) await this.deps.release(ticketId);
      return { sessionId: run.sessionId };
    }
    // 新票安装后 CLI 可立即完成，通知可能早于 RPC 回执；先登记对应票，防止旧票释放误收口。
// 先登记再发送，保证极早到达的完成通知也能对上票。
    const delivery: TicketDelivery = {
      previousTicketId: run.ticketId,
      control: {
        sessionId: run.sessionId,
        executionId: run.executionId,
        action: "replace_ticket",
        renewalId,
        ticketId,
        requestAuth: structuredClone(requestAuth),
      },
    };
// 本地票据立即指向新票，旧票只在明确拒绝时回滚。
    run.ticketId = ticketId;
    run.ticketDelivery = delivery;
// 等待控制命令确认，失败由上层按可重试处理。
    await this.sendTicket(run, delivery);
    return { sessionId: run.sessionId };
  }

  /** 复用既有同步周期；未知回执只重试同一控制命令，不重取票或重放任务。 */
// 重试只针对未确认的换票命令，不重取票、不重放任务。
  async retryPendingTickets(): Promise<void> {
    await Promise.all(
      [...this.runs.values()].map((run) =>
        run.ticketDelivery ? this.sendTicket(run, run.ticketDelivery) : undefined,
      ),
    );
  }

// 同一交接复用 inFlight，避免并发重复发送。
  private sendTicket(run: ResidentExecution, delivery: TicketDelivery): Promise<void> {
    if (delivery.inFlight) return delivery.inFlight;
    const pending = this.confirmTicket(run, delivery).finally(() => {
      delivery.inFlight = undefined;
    });
    delivery.inFlight = pending;
    return pending;
  }

// 确认阶段区分「接受」「拒绝」与「已过期」三类结果。
  private async confirmTicket(run: ResidentExecution, delivery: TicketDelivery): Promise<void> {
    // RPC 抛错不代表 CLI 未安装。保留原票及凭据，retakeGuard 同时禁止 Host 回队重取。
// RPC 抛错不代表 CLI 未安装，因此不在 catch 中回滚本地票。
    const result = await run.control(delivery.control);
// 期间 discarded 或 ticketDelivery 被替换时，本次结果作废。
    if (run.discarded || run.ticketDelivery !== delivery) return;
    run.ticketDelivery = undefined;
// 接受后清空对应代次，防止旧 ACK 再次触发续票。
    if (result.accepted) {
      if (run.renewalId === delivery.control.renewalId) run.renewalId = undefined;
    } else {
// 拒绝时回滚本地票并释放新票。
      run.ticketId = delivery.previousTicketId;
      await this.deps.release(delivery.control.ticketId);
      this.finish(run);
// 只有仍属自动调度时才允许重新申请。
      if (!run.userOwned && !run.terminal) {
        // 只有明确拒绝才允许重新申请；同步重试也须经过同一续票入口恢复调度。
// deps.renew 重试同样走续票入口，保持调度语义一致。
        await this.deps.renew(run.offPeakTaskId, this.retakeGuard(run.offPeakTaskId));
        throw new Error("off_peak_ticket_handoff_rejected");
      }
    }
  }

// cancel 是用户显式动作，立即置 userOwned 阻断自动续票。
  async cancel(taskId: string): Promise<boolean> {
    const run = this.runs.get(taskId);
// 未知或已销毁的执行视为已取消，不再发控制命令。
    if (!run || run.discarded) return false;
    run.renewalId = undefined;
    // 立即阻止已在途重取号写回；CLI 的 completed 仍是生命周期收口事件。
    run.userOwned = true;
    // 注册早于首轮 admission；太早发控制请求会被 CLI 拒绝并丢失用户取消。
    await run.ready;
    if (run.discarded) return true;
// 取消命令必须等 admission 之后发送，否则会被 CLI 拒绝。
    await run.control({ sessionId: run.sessionId, executionId: run.executionId, action: "cancel" });
    return true;
  }

// 整体销毁：所有执行标记丢弃并放行等待者。
  dispose(): void {
    for (const run of this.runs.values()) {
      run.discarded = true;
      run.admit();
    }
    this.runs.clear();
  }
// finish 的收口条件为 completedWritten 为真且 releasedTickets 含当前票。
  private finish(run: ResidentExecution): void {
// 任一条件未满足则保留执行，等待后续事件。
    if (!run.completedWritten || !run.releasedTickets.has(run.ticketId)) return;
    run.discarded = true;
    if (this.runs.get(run.offPeakTaskId) === run) this.runs.delete(run.offPeakTaskId);
// 从 runs 移除后经 disposed 通知注册方做资源清理。
    run.disposed?.();
  }
}
